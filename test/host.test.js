import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  analyzeRepo,
  apply,
  buildHeader,
  buildModelInput,
  classify,
  commitPlan,
  extractMessages,
  groupEntries,
  isSensitive,
  normalizeMessage,
  parseStatus,
  renderPlan,
  resolveConfig,
  scopeOf,
  validateMessage,
} from '../index.js';

const exec = promisify(execFile);
const GIT = 'git';

/**
 * Create a temporary repository with one initial commit.
 * @returns `{ dir, cleanup }`.
 */
async function createRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sc-test-'));
  await exec(GIT, ['init', '-q', '-b', 'main'], { cwd: dir });
  await exec(GIT, ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await exec(GIT, ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# Repo\n', 'utf8');
  await exec(GIT, ['add', '--', 'README.md'], { cwd: dir });
  await exec(GIT, ['commit', '-q', '-m', 'docs: 初始化 README'], { cwd: dir });
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Apply one representative working-tree change set.
 * @param dir - repository directory.
 */
async function populate(dir) {
  await writeFile(join(dir, 'README.md'), '# Repo\n\n更新说明。\n', 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'app.js'), 'export const app = 1;\n', 'utf8');
  await writeFile(join(dir, 'src', 'util.js'), 'export const util = 2;\n', 'utf8');
  await mkdir(join(dir, 'test'), { recursive: true });
  await writeFile(join(dir, 'test', 'app.test.js'), 'test("x", () => {});\n', 'utf8');
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(dir, '.env'), 'SECRET=1\n', 'utf8');
}

/**
 * Mount the plugin on a stub Host context.
 * @param config - row config.
 * @param cwd - Session working directory.
 * @returns the registered commands and the fake agent.
 */
function harness(config, cwd, services = {}) {
  const commands = [];
  const ctx = {
    get: (name) => services[name],
    inject: (_names, callback) => callback(ctx),
    effect: (callback) => {
      callback();
      return () => {};
    },
    commands: {
      register: (definition) => {
        commands.push(definition);
        return () => {};
      },
    },
  };
  if (services.llm === undefined) services.llm = autoLlm();
  const agent = {
    id: 'session-1',
    session: {
      header: { cwd },
      requestHeader: () => ({
        config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      }),
    },
  };
  apply(ctx, config);
  return { commands, agent };
}

/**
 * A stub LLM service whose stream yields one reply, or one terminal failure.
 * @param reply - assistant text.
 * @param options - `fail` turns the reply into a TRANSPORT-style terminal error.
 * @returns the service stubs `ctx.get('llm')` returns.
 */
function fakeLlm(reply, { fail = false } = {}) {
  const replies = Array.isArray(reply) ? [...reply] : [reply];
  let call = 0;
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } };
    },
    async *stream() {
      if (fail) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } },
        };
        return;
      }
      const text = replies[Math.min(call, replies.length - 1)] ?? '';
      call += 1;
      yield { type: 'text-delta', text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

/** A stub LLM that answers with one valid header per requested group. */
function autoLlm() {
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } };
    },
    async *stream(options) {
      const text = options.messages
        .flatMap((message) => message.content ?? [])
        .map((block) => block.text ?? '')
        .join('\n');
      const count = Number(/共 (\d+) 组改动/.exec(text)?.[1] ?? 0);
      const messages = Array.from(
        { length: count },
        (_, index) => `refactor(model): 模型生成第 ${index + 1} 条`,
      );
      yield { type: 'text-delta', text: JSON.stringify({ messages }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('classifies, scopes, and skips sensitive paths', () => {
  assert.equal(classify('README.md', ' M'), 'docs');
  assert.equal(classify('.github/workflows/ci.yml', ' M'), 'ci');
  assert.equal(classify('test/app.test.js', '??'), 'test');
  assert.equal(classify('package.json', ' M'), 'build');
  assert.equal(classify('src/app.js', '??'), 'feat');
  assert.equal(classify('src/app.js', ' M'), 'refactor');

  assert.equal(scopeOf('README.md'), '');
  assert.equal(scopeOf('src/app.js'), 'src');
  assert.equal(scopeOf('backend/coal-mind-agent/Dockerfile'), 'backend-coal-mind-agent');

  assert.equal(isSensitive('.env'), true);
  assert.equal(isSensitive('config/.env.local'), true);
  assert.equal(isSensitive('.env.example'), false);
  assert.equal(isSensitive('deploy/key.pem'), true);
  assert.equal(isSensitive('id_rsa'), true);
  assert.equal(isSensitive('src/app.js'), false);
});

test('parses porcelain -z status including renames', () => {
  const entries = parseStatus(' M src/a.js\0?? src/b.js\0R  src/c.js\0src/old.js\0');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[1], { code: '??', path: 'src/b.js', original: undefined });
  assert.equal(entries[2].path, 'src/c.js');
  assert.equal(entries[2].original, 'src/old.js');
});

test('groups by type and scope and keeps messages valid', () => {
  const { groups, skipped } = groupEntries([
    { code: ' M', path: 'README.md' },
    { code: '??', path: 'src/app.js' },
    { code: '??', path: 'src/util.js' },
    { code: '??', path: 'test/app.test.js' },
    { code: ' M', path: '.github/workflows/ci.yml' },
    { code: ' M', path: 'package.json' },
    { code: '??', path: '.env' },
  ]);
  assert.deepEqual(skipped, ['.env']);
  assert.equal(groups.length, 5);
  for (const group of groups) {
    assert.equal(validateMessage(group.message), null, group.message);
  }
  const feats = groups.filter((group) => group.type === 'feat');
  assert.equal(feats.length, 1);
  assert.deepEqual(feats[0].files, ['src/app.js', 'src/util.js']);
});

test('consolidates whole types past maxGroups without mixing or losing files', () => {
  const entries = [
    { code: '??', path: 'a/one.ts' },
    { code: ' M', path: 'a/one.spec.ts' },
    { code: ' M', path: 'a/two.md' },
    { code: '??', path: 'b/three.ts' },
    { code: ' M', path: 'b/four.ts' },
  ];
  const { groups } = groupEntries(entries, 3);
  // feat(a) + feat(b) merge, leaving four type-pure groups.
  assert.equal(groups.length, 4);
  assert.equal(new Set(groups.map((group) => group.type)).size, groups.length);
  const covered = groups.flatMap((group) => group.files).sort();
  assert.deepEqual(covered, entries.map((entry) => entry.path).sort());
  for (const group of groups) assert.equal(validateMessage(group.message), null);
});

test('validates the Angular message rules', () => {
  assert.equal(validateMessage('fix(auth): 修正令牌刷新'), null);
  assert.equal(validateMessage('chore: 杂务'), 'type 不在枚举内：chore');
  assert.equal(validateMessage('fix: 句号。'), 'subject 结尾不要标点');
  assert.equal(validateMessage('fix: 首字母大写'), null);
  assert.equal(validateMessage('fix(Auth): 大小写 scope'), 'header 不符合 <type>(<scope>): <subject>');
  assert.equal(validateMessage('fix: 空行缺失\nbody'), 'header 与 body 之间必须空一行');
  assert.equal(validateMessage('feat!: 重写接口'), 'header 用 ! 标记破坏性变更时，body 需写 BREAKING CHANGE: 说明');
  assert.equal(
    validateMessage('feat!: 重写接口\n\nBREAKING CHANGE: 调用方需补齐参数'),
    null,
  );
  assert.equal(validateMessage(buildHeader('refactor', 'backend-coal-mind-agent', '更新 一个非常长的文件名.ts')), null);
});

test('analyzes a real working tree and renders the plan', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({
      gitBin: GIT,
      cwd: repo.dir,
      maxGroups: 6,
      timeoutMs: 20000,
    });
    assert.equal(analysis.ok, true);
    assert.equal(analysis.plan.cwd, await realpath(repo.dir));
    assert.equal(analysis.plan.branch, 'main');
    assert.equal(analysis.plan.hasHead, true);
    assert.equal(analysis.plan.groups.length, 5);
    assert.deepEqual(analysis.plan.skipped, ['.env']);

    const text = renderPlan(analysis.plan);
    assert.match(text, /^待确认 5 组 \/ 6 个文件 · main/m);
    assert.match(text, /跳过 1 个敏感文件：\.env/);

    const parsed = text
      .split('\n')
      .map((line) => /^(\d+)\.\s+(.+?)\s+·\s+(\d+)\s+个文件\s*$/u.exec(line))
      .filter(Boolean);
    assert.equal(parsed.length, 5);
    for (const [, , message] of parsed) assert.equal(validateMessage(message), null);
  } finally {
    await repo.cleanup();
  }
});

test('commits every group without touching staged content or secrets', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({
      gitBin: GIT,
      cwd: repo.dir,
      maxGroups: 6,
      timeoutMs: 20000,
    });
    assert.equal(analysis.ok, true);

    const messages = analysis.plan.groups.map((group) => group.message);
    messages[0] = 'docs: 补充 README 说明';
    const outcome = await commitPlan(analysis.plan, messages, { gitBin: GIT, timeoutMs: 20000 });
    assert.equal(outcome.ok, true, outcome.text);
    assert.match(outcome.text, /提交完成：5 组/);

    const { stdout } = await exec(GIT, ['log', '--format=%s', '-6'], { cwd: repo.dir });
    const subjects = stdout.trim().split('\n');
    assert.equal(subjects.length, 6);
    assert.ok(subjects.includes('docs: 补充 README 说明'));
    for (const message of messages) assert.ok(subjects.includes(message), message);

    // The sensitive file stays untracked, everything else is committed.
    const status = await exec(GIT, ['status', '--porcelain'], { cwd: repo.dir });
    assert.equal(status.stdout.trim(), '?? .env');
    const tracked = await exec(GIT, ['ls-files', '--', '.env'], { cwd: repo.dir });
    assert.equal(tracked.stdout.trim(), '');
  } finally {
    await repo.cleanup();
  }
});

test('refuses to commit when the index already holds content', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    await exec(GIT, ['add', '--', 'README.md'], { cwd: repo.dir });
    const analysis = await analyzeRepo({
      gitBin: GIT,
      cwd: repo.dir,
      maxGroups: 6,
      timeoutMs: 20000,
    });
    assert.equal(analysis.ok, true);
    const messages = analysis.plan.groups.map((group) => group.message);
    const outcome = await commitPlan(analysis.plan, messages, { gitBin: GIT, timeoutMs: 20000 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /暂存区还有未决内容/);
  } finally {
    await repo.cleanup();
  }
});

test('rejects an invalid edited message before committing anything', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({
      gitBin: GIT,
      cwd: repo.dir,
      maxGroups: 6,
      timeoutMs: 20000,
    });
    const messages = analysis.plan.groups.map((group) => group.message);
    messages[0] = 'chore: 杂务';
    const outcome = await commitPlan(analysis.plan, messages, { gitBin: GIT, timeoutMs: 20000 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /message 不合规/);
    const { stdout } = await exec(GIT, ['log', '--format=%s'], { cwd: repo.dir });
    assert.equal(stdout.trim(), 'docs: 初始化 README');
  } finally {
    await repo.cleanup();
  }
});

test('reports a directory that is not a repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sc-nogit-'));
  try {
    const analysis = await analyzeRepo({ gitBin: GIT, cwd: dir, maxGroups: 6, timeoutMs: 20000 });
    assert.equal(analysis.ok, false);
    assert.match(analysis.text, /不是 Git 仓库/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('handler stages then commits through one command name', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, 'smart-commit');
    const handler = commands[0].handler;

    const staged = await handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'success');
    assert.match(staged.text, /^待确认 5 组/);

    const committed = await handler({ agent, rawInput: 'commit', attachments: [] });
    assert.equal(committed.kind, 'success', committed.text);
    assert.match(committed.text, /提交完成：5 组/);

    const again = await handler({ agent, rawInput: 'commit', attachments: [] });
    assert.equal(again.kind, 'error');
    assert.match(again.text, /没有待提交的分组/);
  } finally {
    await repo.cleanup();
  }
});

test('handler applies edited messages sent as JSON', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir);
    const handler = commands[0].handler;
    const staged = await handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'success');
    const parsed = staged.text
      .split('\n')
      .map((line) => /^(\d+)\.\s+(.+?)\s+·\s+(\d+)\s+个文件\s*$/u.exec(line))
      .filter(Boolean);
    const messages = parsed.map(([, , message]) => message);
    messages[0] = 'docs: 修改 README 说明';
    const committed = await handler({
      agent,
      rawInput: `commit ${JSON.stringify({ messages })}`,
      attachments: [],
    });
    assert.equal(committed.kind, 'success', committed.text);
    const { stdout } = await exec(GIT, ['log', '--format=%s', '-1'], { cwd: repo.dir });
    assert.equal(stdout.trim(), messages[messages.length - 1]);
    const all = await exec(GIT, ['log', '--format=%s', '-6'], { cwd: repo.dir });
    assert.ok(all.stdout.split('\n').includes('docs: 修改 README 说明'));
  } finally {
    await repo.cleanup();
  }
});

test('handler decodes a base64 message payload from the button', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir);
    const handler = commands[0].handler;
    const staged = await handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'success');
    const parsed = staged.text
      .split('\n')
      .map((line) => /^(\d+)\.\s+(.+?)\s+·\s+(\d+)\s+个文件\s*$/u.exec(line))
      .filter(Boolean);
    const messages = parsed.map(([, , message]) => message);
    messages[1] = 'docs: 补充 README 使用说明';
    const payload = Buffer.from(JSON.stringify({ messages }), 'utf8').toString('base64');
    const committed = await handler({ agent, rawInput: `commit ${payload}`, attachments: [] });
    assert.equal(committed.kind, 'success', committed.text);
    const { stdout } = await exec(GIT, ['log', '--format=%s', '-6'], { cwd: repo.dir });
    assert.ok(stdout.split('\n').includes('docs: 补充 README 使用说明'));
  } finally {
    await repo.cleanup();
  }
});

test('model messages replace the heuristic ones in one call', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const generated = Array.from({ length: 5 }, (_, index) => `refactor(model): 模型生成 message ${index + 1}`);
    const llm = fakeLlm(JSON.stringify({ messages: generated }));
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir, { llm });
    const staged = await commands[0].handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'success', staged.text);
    assert.match(staged.text, /deepseek-official\/deepseek-flash 生成了全部 5 条 message/);
    for (const message of generated) assert.ok(staged.text.includes(message), message);
    assert.doesNotMatch(staged.text, /docs: 更新 README\.md/);
  } finally {
    await repo.cleanup();
  }
});

test('a failed model call aborts instead of committing heuristic messages', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir, { llm: fakeLlm('', { fail: true }) });
    const staged = await commands[0].handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'error', staged.text);
    assert.match(staged.text, /模型总结不可用（DeepSeek Messages transport failed）/);
    assert.match(staged.text, /没有生成分组/);
  } finally {
    await repo.cleanup();
  }
});

test('model output that is not the agreed JSON aborts the run', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir, { llm: fakeLlm('对不起，我不能输出 JSON') });
    const staged = await commands[0].handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'error', staged.text);
    assert.match(staged.text, /模型输出不是约定的 JSON/);
  } finally {
    await repo.cleanup();
  }
});

test('an invalid header is repaired by one targeted model round', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const first = JSON.stringify({
      messages: [
        'build(backend-coal-mind-agent): 更新镜像权限',
        'chore: 杂务',
        'docs: 补充说明',
        '没有格式',
        'test(backend-coal-mind-agent): 补充文档用例',
      ],
    });
    const repaired = JSON.stringify({ messages: ['ci: 调整流水线', 'feat(agent): 新增文档生成能力'] });
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir, { llm: fakeLlm([first, repaired]) });
    const staged = await commands[0].handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'success', staged.text);
    assert.match(staged.text, /生成了全部 5 条 message/);
    assert.ok(staged.text.includes('ci: 调整流水线'));
    assert.ok(staged.text.includes('feat(agent): 新增文档生成能力'));
    assert.doesNotMatch(staged.text, /待补充 message/);
  } finally {
    await repo.cleanup();
  }
});

test('a header still invalid after repair blocks its group instead of guessing', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const first = JSON.stringify({
      messages: [
        'chore: 杂务',
        'docs: 补充说明',
        'build: 更新依赖',
        'test: 补充用例',
        'ci: 调整流水线',
      ],
    });
    const repaired = JSON.stringify({ messages: ['chore: 还是杂务'] });
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir, { llm: fakeLlm([first, repaired]) });
    const staged = await commands[0].handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'success', staged.text);
    assert.match(staged.text, /1 组还没有可用的模型 message/);
    assert.match(staged.text, /第 1 组：type 不在枚举内：chore/);
    assert.match(staged.text, /（待补充 message）/);
    assert.doesNotMatch(staged.text, /refactor: 调整 1 个文件/);
  } finally {
    await repo.cleanup();
  }
});

test('normalizeMessage fixes casing and trailing punctuation only', () => {
  assert.equal(normalizeMessage('Fix(Auth): 修正令牌。'), 'fix(auth): 修正令牌');
  assert.equal(normalizeMessage('feat(Web-UI):  支持导出  '), 'feat(web-ui): 支持导出');
  assert.equal(normalizeMessage('docs: 补充说明'), 'docs: 补充说明');
  assert.equal(normalizeMessage('   '), '');
  assert.equal(normalizeMessage('没有格式'), '没有格式');
});

test('model input carries paths, diff text, and the budget', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({ gitBin: GIT, cwd: repo.dir, maxGroups: 6, timeoutMs: 20000 });
    const input = await buildModelInput(GIT, analysis.plan, { budget: 100000, timeoutMs: 20000 });
    assert.match(input, /共 5 组改动/);
    assert.match(input, /README\.md/);
    assert.match(input, /^\+更新说明/m);
    const bounded = await buildModelInput(GIT, analysis.plan, { budget: 200, timeoutMs: 20000 });
    assert.ok(bounded.length < 1200, `bounded input was ${bounded.length} chars`);
  } finally {
    await repo.cleanup();
  }
});

test('extractMessages finds the JSON object in prose and fences', () => {
  assert.deepEqual(extractMessages('```json\n{"messages":["a: b"]}\n```'), ['a: b']);
  assert.deepEqual(extractMessages('好的：{"messages":["a: b","c: d"]} 完成'), ['a: b', 'c: d']);
  assert.equal(extractMessages('no json here'), null);
  assert.equal(extractMessages('{"messages":[1,2]}'), null);
});

test('handler refuses a pre-existing index, then releases it on request', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    await exec(GIT, ['add', '--', 'README.md'], { cwd: repo.dir });
    const { commands, agent } = harness({ gitPath: GIT }, repo.dir);
    const handler = commands[0].handler;

    const staged = await handler({ agent, rawInput: '', attachments: [] });
    assert.equal(staged.kind, 'success', staged.text);
    assert.match(staged.text, /暂存区已有 1 个文件/);
    assert.match(staged.text, /^\s+! README\.md$/m);

    const refused = await handler({ agent, rawInput: 'commit', attachments: [] });
    assert.equal(refused.kind, 'error');
    assert.match(refused.text, /取消暂存/);

    const release = Buffer.from(
      JSON.stringify({
        messages: staged.text
          .split('\n')
          .map((line) => /^(\d+)\.\s+(.+?)\s+·\s+(\d+)\s+个文件\s*$/u.exec(line))
          .filter(Boolean)
          .map(([, , message]) => message),
        unstage: true,
      }),
      'utf8',
    ).toString('base64');
    const committed = await handler({ agent, rawInput: `commit ${release}`, attachments: [] });
    assert.equal(committed.kind, 'success', committed.text);
    const log = await exec(GIT, ['log', '--format=%s', '-6'], { cwd: repo.dir });
    assert.ok(log.stdout.split('\n').some((subject) => subject.startsWith('docs:')));
    const index = await exec(GIT, ['diff', '--cached', '--name-only'], { cwd: repo.dir });
    assert.equal(index.stdout.trim(), '');
  } finally {
    await repo.cleanup();
  }
});

test('a failing commit puts this run staging back and keeps the work', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const hook = join(repo.dir, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(hook, 0o755);

    const analysis = await analyzeRepo({ gitBin: GIT, cwd: repo.dir, maxGroups: 6, timeoutMs: 20000 });
    const messages = analysis.plan.groups.map((group) => group.message);
    const outcome = await commitPlan(analysis.plan, messages, { gitBin: GIT, timeoutMs: 20000 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /提交失败/);
    assert.match(outcome.text, /移出暂存区/);

    const index = await exec(GIT, ['diff', '--cached', '--name-only'], { cwd: repo.dir });
    assert.equal(index.stdout.trim(), '');
    const work = await exec(GIT, ['status', '--porcelain'], { cwd: repo.dir });
    assert.match(work.stdout, /README\.md/);
    const log = await exec(GIT, ['log', '--format=%s'], { cwd: repo.dir });
    assert.equal(log.stdout.trim(), 'docs: 初始化 README');
  } finally {
    await repo.cleanup();
  }
});

test('config defaults clamp bad values', () => {
  const defaults = resolveConfig(undefined);
  assert.equal(defaults.gitPath, '');
  assert.equal(defaults.timeoutMs, 20000);
  assert.equal(defaults.maxGroups, 6);

  const custom = resolveConfig({ gitPath: ' /usr/bin/git ', timeoutMs: -1, maxGroups: 0 });
  assert.equal(custom.gitPath, '/usr/bin/git');
  assert.equal(custom.timeoutMs, 20000);
  assert.equal(custom.maxGroups, 6);
});
