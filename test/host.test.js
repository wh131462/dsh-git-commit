import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import {
  analyzeRepo,
  apply,
  applyModelGroups,
  assertPlanMatches,
  buildGroupingInput,
  buildUnitGroupingInput,
  expandUnitGroups,
  buildHeader,
  buildModelInput,
  classify,
  commitPlan,
  createApi,
  createRouteHandler,
  extractGroupPlan,
  extractMessages,
  groupEntries,
  isSensitive,
  normalizeMessage,
  parseStatus,
  planFromSubmitted,
  publicPlan,
  recoverGitLock,
  resolveConfig,
  scopeOf,
  validateMessage,
} from '../index.js';

const exec = promisify(execFile);
const GIT = 'git';
const SESSION = 'session-1';

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
 * A stub Host context with the three services the API reads.
 * @param cwd - Session working directory.
 * @param options - session id, LLM stub, admission result.
 * @returns a fake `ctx`.
 */
function makeCtx(cwd, { sessionId = SESSION, llm = autoLlm(), admit } = {}) {
  const sessions = new Map([
    [
      sessionId,
      {
        header: { cwd },
        requestHeader: () => ({
          config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
        }),
      },
    ],
  ]);
  return {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) };
      if (name === 'workingDirectory') return { get: (session) => session.header.cwd };
      if (name === 'llm') return llm;
      if (name === 'connection') {
        return { admit: admit ?? (() => ({ peer: { principal: { kind: 'owner' } } })) };
      }
      return undefined;
    },
    logger: { warn() {} },
  };
}

/**
 * Build the API against a stub context and the real git binary.
 * @param cwd - Session working directory.
 * @param options - extra config, session id, and LLM stub.
 * @returns `{ api, ctx, config }`.
 */
function makeApi(cwd, { config, ...rest } = {}) {
  const resolved = resolveConfig({ gitPath: GIT, ...config });
  const ctx = makeCtx(cwd, rest);
  return { api: createApi(ctx, resolved), ctx, config: resolved };
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

/** The prompt text a stub call received. */
function promptText(options) {
  return options.messages
    .flatMap((message) => message.content ?? [])
    .map((block) => block.text ?? '')
    .join('\n');
}

/**
 * The stub's grouping answer: cluster the numbered file list by type hint.
 * @param text - the grouping prompt.
 * @returns `{ groups }` in the agreed shape.
 */
/** One stub group per rule bucket, matching the host's own classification. */
function autoGrouping(text) {
  const units = [...text.matchAll(/^\[(\d+)\] ([a-z-]+)(?:\/[^\s·]+)? · /gmu)];
  if (units.length > 0) {
    return {
      groups: [
        {
          units: units.map((match) => Number(match[1])),
          type: 'refactor',
          scope: '',
          message: 'refactor: 模型按单元合并',
        },
      ],
    };
  }
  const byType = new Map();
  for (const line of text.split('\n')) {
    const match = /^(\d+)\.\s+(.{2})\s+(.*?)(?:\s+\[([a-z]+)\])?$/u.exec(line);
    if (match === null) continue;
    const type = match[4] ?? classify(match[3], match[2]);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(Number(match[1]));
  }
  return {
    groups: [...byType.entries()].map(([type, paths], position) => ({
      paths,
      type,
      scope: '',
      message: `${type}: 模型生成第 ${position + 1} 组`,
    })),
  };
}

/** A stub LLM that plays the grouping protocol and names each group. */
function autoLlm() {
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } };
    },
    async *stream(options) {
      yield { type: 'text-delta', text: JSON.stringify(autoGrouping(promptText(options))) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

/** One fake request stream for the route handler. */
function fakeRequest({ method = 'POST', url = '/dsh-git-commit/analyze', body = {}, contentType = 'application/json' }) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = url;
  request.headers = contentType === null ? {} : { 'content-type': contentType };
  return request;
}

/** One fake response that records status, headers, and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writableEnded: false,
    listeners: new Map(),
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text = '') {
      this.body = text;
      this.writableEnded = true;
    },
    on(event, listener) {
      this.listeners.set(event, listener);
      return this;
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

test('rejects subjects that only report a count or a bare scope', () => {
  const reason = 'subject 只报了数量或范围，没有写出这组具体改了什么';
  assert.equal(validateMessage('refactor: 修改了 12 个文件'), reason);
  assert.equal(validateMessage('docs: 更新 3 个文档'), reason);
  assert.equal(validateMessage('test: 调整 5 个测试'), reason);
  assert.equal(validateMessage('build: 更新 3 个配置'), reason);
  assert.equal(validateMessage('docs: 更新文件'), reason);
  assert.equal(validateMessage('refactor: 调整'), reason);
  assert.equal(validateMessage('refactor: changed 12 files'), reason);
  assert.equal(validateMessage('docs: update files'), reason);
  // A count of something concrete still describes the change.
  assert.equal(validateMessage('feat: 新增 2 个接口'), null);
  assert.equal(validateMessage('perf: 优化列表渲染'), null);
  assert.equal(validateMessage('feat: add 2 login endpoints'), null);
});

test('rule messages name paths instead of counting files', () => {
  const { groups } = groupEntries(
    [
      { code: '??', path: 'src/alpha/app.js' },
      { code: '??', path: 'src/beta/app.js' },
      { code: ' M', path: 'docs/guide/intro.md' },
      { code: ' M', path: 'docs/guide/install.md' },
    ],
    1,
  );
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.equal(validateMessage(group.message), null, group.message);
    assert.doesNotMatch(group.message, /\d+\s*个(文件|文档|测试|配置)/, group.message);
  }
  const feats = groups.find((group) => group.type === 'feat');
  assert.match(feats.message, /alpha\/app\.js/);
  assert.match(feats.message, /beta\/app\.js/);
  const docs = groups.find((group) => group.type === 'docs');
  assert.match(docs.message, /intro\.md/);
  assert.match(docs.message, /install\.md/);
});

test('analyzes a real working tree into a wire plan', async () => {
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

    const plan = publicPlan(analysis.plan);
    assert.equal(plan.vcs, 'git');
    assert.equal(plan.groups.length, 5);
    for (const group of plan.groups) {
      assert.equal(validateMessage(group.message), null, group.message);
      assert.equal(group.files.length > 0, true);
    }
    assert.equal('cwd' in plan, false);
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

    const status = await exec(GIT, ['status', '--porcelain'], { cwd: repo.dir });
    assert.equal(status.stdout.trim(), '?? .env');
    const tracked = await exec(GIT, ['ls-files', '--', '.env'], { cwd: repo.dir });
    assert.equal(tracked.stdout.trim(), '');
  } finally {
    await repo.cleanup();
  }
});

test('clears an orphaned index.lock and commits the tree', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const lock = join(repo.dir, '.git', 'index.lock');
    await writeFile(lock, '', 'utf8');

    const probe = await recoverGitLock(GIT, repo.dir, { timeoutMs: 20000 });
    assert.equal(probe.status, 'removed', JSON.stringify(probe));
    assert.equal(probe.path, lock);
    await assert.rejects(stat(lock), /ENOENT/);

    // The same recovery has to work from inside a commit: a lock that appears
    // after analysis must not abort the run.
    await writeFile(lock, '', 'utf8');
    const analysis = await analyzeRepo({
      gitBin: GIT,
      cwd: repo.dir,
      maxGroups: 6,
      timeoutMs: 20000,
    });
    assert.equal(analysis.ok, true, analysis.text);
    const messages = analysis.plan.groups.map((group) => group.message);
    const outcome = await commitPlan(analysis.plan, messages, { gitBin: GIT, timeoutMs: 20000 });
    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(existsSync(lock), false);
  } finally {
    await repo.cleanup();
  }
});

test('clears the exact lock path git reported, not just the index', async () => {
  const repo = await createRepo();
  try {
    const lock = join(repo.dir, '.git', 'refs', 'heads', 'main.lock');
    await writeFile(lock, '', 'utf8');
    const probe = await recoverGitLock(GIT, repo.dir, {
      timeoutMs: 20000,
      stderr: `fatal: Unable to create '${lock}': File exists.`,
    });
    assert.equal(probe.status, 'removed');
    assert.equal(probe.path, lock);
    await assert.rejects(stat(lock), /ENOENT/);
  } finally {
    await repo.cleanup();
  }
});

test(
  'keeps a lock that a live process holds and names the holder',
  { skip: process.platform === 'win32' },
  async () => {
    const repo = await createRepo();
    const lock = join(repo.dir, '.git', 'index.lock');
    let holder;
    try {
      await populate(repo.dir);
      await writeFile(lock, '', 'utf8');
      holder = spawn(
        process.execPath,
        ['-e', "require('node:fs').openSync(process.argv[1], 'r'); setInterval(() => {}, 1000);", lock],
        { stdio: 'ignore' },
      );

      // Wait for the descriptor to be observable: lsof on macOS, /proc on Linux.
      let probe = { status: 'none', pids: [] };
      for (let attempt = 0; attempt < 60; attempt += 1) {
        probe = await recoverGitLock(GIT, repo.dir, { timeoutMs: 20000 });
        if (probe.status === 'held') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(probe.status, 'held', JSON.stringify(probe));
      assert.deepEqual(probe.pids, [holder.pid]);
      assert.equal(existsSync(lock), true, 'a live lock must never be deleted');

      const analysis = await analyzeRepo({
        gitBin: GIT,
        cwd: repo.dir,
        maxGroups: 6,
        timeoutMs: 20000,
      });
      const pid = `PID ${holder.pid}`;
      if (analysis.ok) {
        const messages = analysis.plan.groups.map((group) => group.message);
        const outcome = await commitPlan(analysis.plan, messages, { gitBin: GIT, timeoutMs: 20000 });
        assert.equal(outcome.ok, false);
        assert.match(outcome.text, new RegExp(pid));
      } else {
        // `git status` may already need the index; its message must name the holder too.
        assert.match(analysis.text, new RegExp(pid));
      }
      assert.equal(existsSync(lock), true, 'the commit must leave the live lock alone');
    } finally {
      holder?.kill('SIGKILL');
      await repo.cleanup();
    }
  },
);

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

test('api.analyze returns groups with empty messages and a model label', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir);
    const result = await api.analyze({ sessionId: SESSION });
    assert.equal(result.plan.groups.length, 5);
    assert.equal(result.useModel, true);
    assert.equal(result.model, 'deepseek-official/deepseek-flash');
    for (const group of result.plan.groups) {
      assert.equal(group.message, '');
      assert.notEqual(group.suggestion, '');
    }
    assert.deepEqual(result.plan.skipped, ['.env']);
  } finally {
    await repo.cleanup();
  }
});

test('api.analyze reports a clean tree as an informational failure', async () => {
  const repo = await createRepo();
  try {
    const { api } = makeApi(repo.dir);
    await assert.rejects(
      api.analyze({ sessionId: SESSION }),
      (error) => error.code === 'clean' && /工作区干净/.test(error.message),
    );
  } finally {
    await repo.cleanup();
  }
});

test('api.analyze refuses an unknown session', async () => {
  const repo = await createRepo();
  try {
    const { api } = makeApi(repo.dir);
    await assert.rejects(
      api.analyze({ sessionId: 'missing' }),
      (error) => error.code === 'no-session',
    );
  } finally {
    await repo.cleanup();
  }
});

test('api.name lets the model group the files and names every group', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir);
    const analyzed = await api.analyze({ sessionId: SESSION });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 0);
    assert.equal(named.messages.length, named.plan.groups.length);
    for (const message of named.messages) assert.equal(validateMessage(message), null, message);
    // One file per type in the fixture, so the stub's type grouping keeps 5.
    assert.equal(named.plan.groups.length, 5);
    assert.match(named.note, /分成 5 组/);
    assert.match(named.note, /生成了全部 5 条 message/);
    const before = analyzed.plan.groups.flatMap((group) => group.files).sort();
    const after = named.plan.groups.flatMap((group) => group.files).sort();
    assert.deepEqual(after, before);
  } finally {
    await repo.cleanup();
  }
});

test('api.commit writes the confirmed messages', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir);
    const analyzed = await api.analyze({ sessionId: SESSION });
    const messages = analyzed.plan.groups.map((group) => `refactor(model): 提交 ${group.type}`);
    messages[0] = 'docs: 补充 README 说明';
    const outcome = await api.commit({
      sessionId: SESSION,
      plan: analyzed.plan,
      messages,
      unstage: false,
    });
    assert.equal(outcome.ok, true, outcome.text);
    assert.match(outcome.text, /提交完成：5 组/);
    const log = await exec(GIT, ['log', '--format=%s', '-6'], { cwd: repo.dir });
    assert.ok(log.stdout.split('\n').includes('docs: 补充 README 说明'));
  } finally {
    await repo.cleanup();
  }
});

test('api.commit rejects an invalid message before touching the index', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir);
    const analyzed = await api.analyze({ sessionId: SESSION });
    const messages = analyzed.plan.groups.map((group) => group.suggestion);
    messages[0] = 'chore: 杂务';
    await assert.rejects(
      api.commit({ sessionId: SESSION, plan: analyzed.plan, messages, unstage: false }),
      (error) =>
        error.code === 'invalid-message' &&
        /未通过校验/.test(error.message) &&
        error.details.groups[0].index === 0,
    );
    const log = await exec(GIT, ['log', '--format=%s'], { cwd: repo.dir });
    assert.equal(log.stdout.trim(), 'docs: 初始化 README');
    const index = await exec(GIT, ['diff', '--cached', '--name-only'], { cwd: repo.dir });
    assert.equal(index.stdout.trim(), '');
  } finally {
    await repo.cleanup();
  }
});

test('api.commit refuses a plan whose file groups changed', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir);
    const analyzed = await api.analyze({ sessionId: SESSION });
    await writeFile(join(repo.dir, 'src', 'late.js'), 'export const late = 1;\n', 'utf8');
    await assert.rejects(
      api.commit({
        sessionId: SESSION,
        plan: analyzed.plan,
        messages: analyzed.plan.groups.map((group) => group.suggestion),
        unstage: false,
      }),
      (error) => error.code === 'stale' && /重新分析/.test(error.message),
    );
    const log = await exec(GIT, ['log', '--format=%s'], { cwd: repo.dir });
    assert.equal(log.stdout.trim(), 'docs: 初始化 README');
  } finally {
    await repo.cleanup();
  }
});

test('api.commit asks for the unstage checkbox, then releases exactly those paths', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    await exec(GIT, ['add', '--', 'README.md'], { cwd: repo.dir });
    const { api } = makeApi(repo.dir);
    const analyzed = await api.analyze({ sessionId: SESSION });
    assert.deepEqual(analyzed.plan.staged, ['README.md']);
    const messages = analyzed.plan.groups.map((group) => group.suggestion);
    await assert.rejects(
      api.commit({ sessionId: SESSION, plan: analyzed.plan, messages, unstage: false }),
      (error) => error.code === 'staged' && /先取消暂存/.test(error.message),
    );
    const outcome = await api.commit({
      sessionId: SESSION,
      plan: analyzed.plan,
      messages,
      unstage: true,
    });
    assert.equal(outcome.ok, true, outcome.text);
    const index = await exec(GIT, ['diff', '--cached', '--name-only'], { cwd: repo.dir });
    assert.equal(index.stdout.trim(), '');
  } finally {
    await repo.cleanup();
  }
});

test('api.name reports a model transport failure without touching git', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir, { llm: fakeLlm('', { fail: true }) });
    await assert.rejects(
      api.name({ sessionId: SESSION }),
      (error) => error.code === 'model-failed' && /DeepSeek Messages transport failed/.test(error.message),
    );
    const log = await exec(GIT, ['log', '--format=%s'], { cwd: repo.dir });
    assert.equal(log.stdout.trim(), 'docs: 初始化 README');
  } finally {
    await repo.cleanup();
  }
});

test('api.name rejects a non-JSON model reply', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir, { llm: fakeLlm('对不起，我不能输出 JSON') });
    await assert.rejects(
      api.name({ sessionId: SESSION }),
      (error) => error.code === 'model-failed' && /约定的 JSON/.test(error.message),
    );
  } finally {
    await repo.cleanup();
  }
});

test('api.name repairs a count-style subject instead of committing it', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const first = JSON.stringify({
      groups: [
        { files: ['src/app.js', 'src/util.js'], type: 'feat', message: 'feat: 修改了 2 个文件' },
        { files: ['README.md'], type: 'docs', message: 'docs: 补充说明' },
        { files: ['package.json'], type: 'build', message: 'build: 更新包信息' },
        { files: ['.github/workflows/ci.yml'], type: 'ci', message: 'ci: 调整流水线' },
        { files: ['test/app.test.js'], type: 'test', message: 'test: 补充用例' },
      ],
    });
    const repaired = JSON.stringify({ messages: ['feat: 新增入口与工具函数'] });
    const { api } = makeApi(repo.dir, { llm: fakeLlm([first, repaired]) });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 0);
    assert.ok(named.messages.includes('feat: 新增入口与工具函数'));
    assert.ok(!named.messages.some((message) => /\d+\s*个文件/u.test(message)));
    for (const message of named.messages) assert.equal(validateMessage(message), null, message);
  } finally {
    await repo.cleanup();
  }
});

test('api.name repairs invalid headers in one targeted round', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const first = JSON.stringify({
      groups: [
        { files: ['.github/workflows/ci.yml'], type: 'ci', message: 'ci: 调整流水线' },
        { files: ['README.md'], type: 'docs', message: 'docs: 补充说明' },
        { files: ['package.json'], type: 'build', message: 'chore: 升级依赖' },
        { files: ['src/app.js', 'src/util.js'], type: 'feat', message: 'feat: 新增工具模块' },
        { files: ['test/app.test.js'], type: 'test', message: 'test: 补充用例' },
      ],
    });
    const repaired = JSON.stringify({ messages: ['build: 更新依赖字段'] });
    const { api } = makeApi(repo.dir, { llm: fakeLlm([first, repaired]) });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 0);
    assert.match(named.note, /分成 5 组/);
    assert.equal(named.messages.length, 5);
    assert.ok(named.messages.includes('build: 更新依赖字段'));
    for (const message of named.messages) assert.equal(validateMessage(message), null, message);
  } finally {
    await repo.cleanup();
  }
});

test('api.name leaves a still-invalid group empty instead of guessing', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const first = JSON.stringify({
      groups: [
        { files: ['README.md'], type: 'docs', message: 'chore: 杂务' },
        { files: ['src/app.js', 'src/util.js'], type: 'feat', message: 'feat: 新增工具模块' },
        { files: ['test/app.test.js'], type: 'test', message: 'test: 补充用例' },
      ],
    });
    const repaired = JSON.stringify({ messages: ['chore: 还是杂务'] });
    const { api } = makeApi(repo.dir, { llm: fakeLlm([first, repaired]) });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 1);
    assert.equal(named.failures[0].index, 0);
    assert.equal(named.messages[0], '');
    assert.match(named.note, /1 组还没有可用的模型 message/);
    assert.match(named.note, /chore/);
  } finally {
    await repo.cleanup();
  }
});

test('commits the model grouping instead of the rule preview', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    await mkdir(join(repo.dir, 'api'), { recursive: true });
    await writeFile(join(repo.dir, 'api', 'handler.js'), 'export const h = 1;\n', 'utf8');

    const grouped = JSON.stringify({
      groups: [
        {
          files: ['api/handler.js', 'src/app.js', 'src/util.js'],
          type: 'feat',
          message: 'feat: 新增接口与工具模块',
        },
        { files: ['README.md'], type: 'docs', message: 'docs: 补充说明' },
        { files: ['package.json'], type: 'build', message: 'build: 更新包信息' },
        { files: ['.github/workflows/ci.yml'], type: 'ci', message: 'ci: 调整流水线' },
        { files: ['test/app.test.js'], type: 'test', message: 'test: 补充用例' },
      ],
    });
    const { api } = makeApi(repo.dir, { llm: fakeLlm(grouped) });
    const analyzed = await api.analyze({ sessionId: SESSION });
    // The rules keep the two `feat` scopes apart; the model merges them.
    assert.equal(analyzed.plan.groups.length, 6);

    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.plan.groups.length, 5);
    const merged = named.plan.groups.find((group) => group.message === 'feat: 新增接口与工具模块');
    assert.deepEqual(merged.files, ['api/handler.js', 'src/app.js', 'src/util.js']);

    const outcome = await api.commit({
      sessionId: SESSION,
      plan: named.plan,
      messages: named.messages,
      unstage: false,
    });
    assert.equal(outcome.ok, true, outcome.text);
    assert.match(outcome.text, /提交完成：5 组/);

    // The merged group is one commit that holds all three paths.
    const first = await exec(GIT, ['show', '--name-only', '--format=%s', 'HEAD~4'], { cwd: repo.dir });
    assert.match(first.stdout, /^feat: 新增接口与工具模块/m);
    for (const file of ['api/handler.js', 'src/app.js', 'src/util.js']) {
      assert.ok(first.stdout.includes(file), file);
    }
  } finally {
    await repo.cleanup();
  }
});

test('splits objective files out of a mixed model group', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const grouped = JSON.stringify({
      groups: [
        {
          files: ['src/app.js', 'src/util.js', 'README.md', 'test/app.test.js'],
          type: 'feat',
          message: 'feat: 新增工具模块',
        },
        {
          files: ['package.json', '.github/workflows/ci.yml'],
          type: 'build',
          message: 'build: 更新包信息与流水线',
        },
      ],
    });
    const { api } = makeApi(repo.dir, { llm: fakeLlm(grouped) });
    const named = await api.name({ sessionId: SESSION });

    const covered = named.plan.groups.flatMap((group) => group.files).sort();
    assert.equal(new Set(covered).size, 6);
    // Docs, tests, CI, and build never hide inside a source commit.
    const readme = named.plan.groups.find((group) => group.files.includes('README.md'));
    assert.equal(readme.type, 'docs');
    assert.equal(readme.files.length, 1);
    const tests = named.plan.groups.find((group) => group.files.includes('test/app.test.js'));
    assert.equal(tests.type, 'test');
    const source = named.plan.groups.find((group) => group.message === 'feat: 新增工具模块');
    assert.deepEqual(source.files, ['src/app.js', 'src/util.js']);
    assert.match(named.note, /按类型拆成/);
  } finally {
    await repo.cleanup();
  }
});

test('falls back to rule grouping when even the unit list cannot fit', async () => {
  const repo = await createRepo();
  try {
    for (let index = 0; index < 30; index += 1) {
      await mkdir(join(repo.dir, `mod-${index}`), { recursive: true });
      await writeFile(
        join(repo.dir, `mod-${index}`, 'index.js'),
        `export const v${index} = ${index};\n`,
        'utf8',
      );
    }
    // 30 paths and 30 units both outgrow the budget, so the model is not asked.
    const { api } = makeApi(repo.dir, { config: { maxInputChars: 1000 } });
    const named = await api.name({ sessionId: SESSION });
    assert.match(named.note, /改动过多/);
    assert.match(named.note, /手动调整分组/);
    assert.equal(named.failures.length, 0);
    const covered = named.plan.groups.flatMap((group) => group.files).sort();
    assert.equal(covered.length, 30);
    for (const message of named.messages) {
      assert.equal(validateMessage(message), null, message);
      assert.doesNotMatch(message, /\d+\s*个(文件|文档|测试|配置)/, message);
    }
  } finally {
    await repo.cleanup();
  }
});

test('plans by rule units when the path list is too long', async () => {
  const repo = await createRepo();
  try {
    await mkdir(join(repo.dir, 'src', 'deep'), { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        join(repo.dir, 'src', 'deep', `file-${index}.js`),
        `export const v${index} = ${index};\n`,
        'utf8',
      );
    }
    // 40 numbered paths do not fit, but one numbered unit does.
    const { api } = makeApi(repo.dir, { config: { maxInputChars: 1000 } });
    const named = await api.name({ sessionId: SESSION });
    assert.match(named.note, /规则单元/);
    assert.doesNotMatch(named.note, /改动过多/);
    assert.equal(named.failures.length, 0);
    assert.equal(named.plan.groups.length, 1);
    assert.equal(named.plan.groups[0].files.length, 40);
    assert.equal(named.plan.groups[0].message, 'refactor: 模型按单元合并');
  } finally {
    await repo.cleanup();
  }
});

test('unit input numbers rule buckets and expands back to files', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({ gitBin: GIT, cwd: repo.dir, maxGroups: 12, timeoutMs: 20000 });
    const built = await buildUnitGroupingInput(GIT, analysis.plan, {
      budget: 20000,
      timeoutMs: 20000,
      maxGroups: 12,
    });
    assert.ok(built !== null);
    assert.match(built.text, /规则单元/);
    assert.match(built.text, /^\[1\] /m);
    assert.equal(built.units.length, 5);
    const total = built.units.reduce((sum, unit) => sum + unit.files.length, 0);
    assert.equal(total, 6);

    const expanded = expandUnitGroups(
      [{ units: [1, 2], type: 'refactor', scope: '', message: 'refactor: 合并前两个单元' }],
      built.units,
    );
    assert.equal(expanded[0].files.length, built.units[0].files.length + built.units[1].files.length);
    // Out-of-range unit numbers are dropped, never expanded into other files.
    const bounded = expandUnitGroups([{ units: [1, 99], message: '' }], built.units);
    assert.deepEqual(bounded[0].files, built.units[0].files);
  } finally {
    await repo.cleanup();
  }
});

test('fills files the model never claimed with rule groups', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const grouped = JSON.stringify({
      groups: [{ files: ['src/app.js'], type: 'feat', message: 'feat: 新增入口文件' }],
    });
    const { api } = makeApi(repo.dir, { llm: fakeLlm(grouped) });
    const named = await api.name({ sessionId: SESSION });
    const covered = named.plan.groups.flatMap((group) => group.files).sort();
    assert.equal(covered.length, 6);
    assert.equal(new Set(covered).size, 6);
    assert.equal(named.failures.length, 0);
    assert.ok(named.messages.every((message) => message.trim() !== ''));
    assert.match(named.note, /模型没有覆盖/);
    assert.match(named.note, /按规则补成/);
  } finally {
    await repo.cleanup();
  }
});

test('asks the model to name rule-filled groups instead of keeping placeholders', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    // The first reply only claims one path, so the other five become rule
    // groups; the second reply names them semantically.
    const grouped = JSON.stringify({
      groups: [{ files: ['src/app.js'], type: 'feat', message: 'feat: 新增入口文件' }],
    });
    const repaired = JSON.stringify({
      messages: [
        'build: 声明 fixture 包信息',
        'ci: 增加 CI 工作流',
        'docs: 补充工作区更新说明',
        'feat: 新增工具函数',
        'test: 覆盖入口行为',
      ],
    });
    const { api } = makeApi(repo.dir, { llm: fakeLlm([grouped, repaired]) });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 0);
    assert.equal(named.messages.length, 6);
    for (const message of named.messages) assert.equal(validateMessage(message), null, message);
    assert.ok(named.messages.includes('docs: 补充工作区更新说明'));
    assert.ok(named.messages.includes('feat: 新增工具函数'));
    assert.doesNotMatch(named.note, /仍由规则命名/);
    assert.match(named.note, /生成了全部 6 条 message/);
  } finally {
    await repo.cleanup();
  }
});

test('groups the model never named keep a path-named message when naming fails', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const grouped = JSON.stringify({
      groups: [{ files: ['src/app.js'], type: 'feat', message: 'feat: 新增入口文件' }],
    });
    // The naming reply is not the agreed shape, so the rule messages stand.
    const { api } = makeApi(repo.dir, { llm: fakeLlm([grouped, 'not json at all']) });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 0);
    assert.match(named.note, /仍由规则命名/);
    for (const message of named.messages) {
      assert.equal(validateMessage(message), null, message);
      assert.doesNotMatch(message, /\d+\s*个(文件|文档|测试|配置)/, message);
    }
  } finally {
    await repo.cleanup();
  }
});

test('ignores repeated and out-of-range indices without losing files', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const grouped = JSON.stringify({
      groups: [{ paths: [1, 1, 99], type: 'ci', message: 'ci: 调整流水线' }],
    });
    const { api } = makeApi(repo.dir, { llm: fakeLlm(grouped) });
    const named = await api.name({ sessionId: SESSION });
    const covered = named.plan.groups.flatMap((group) => group.files).sort();
    assert.equal(new Set(covered).size, 6);
    assert.equal(named.failures.length, 0);
    assert.match(named.note, /重复编号/);
    assert.match(named.note, /越界编号/);
  } finally {
    await repo.cleanup();
  }
});

test('merges whole types when the model exceeds maxGroups', () => {
  const entries = [
    { code: ' M', path: 'a/one.js' },
    { code: ' M', path: 'b/two.js' },
    { code: ' M', path: 'c/three.js' },
    { code: ' M', path: 'docs/x.md' },
    { code: ' M', path: 'docs/y.md' },
  ];
  const plan = {
    vcs: 'git',
    cwd: '/tmp',
    branch: 'main',
    hasHead: true,
    staged: [],
    skipped: [],
    entries,
    groups: groupEntries(entries, 99).groups,
  };
  const candidates = plan.groups.map((group) => ({
    paths: group.files,
    type: group.type,
    scope: group.scope,
    message: group.message,
  }));
  const applied = applyModelGroups(plan, candidates, { maxGroups: 2 });
  assert.equal(applied.groups.length, 2);
  assert.ok(applied.merged > 0);
  assert.deepEqual(
    applied.groups.flatMap((group) => group.files).sort(),
    entries.map((entry) => entry.path).sort(),
  );
  for (const group of applied.groups) assert.equal(validateMessage(group.message), null, group.message);
});

test('planFromSubmitted rejects duplicates, missing paths, and empty groups', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({ gitBin: GIT, cwd: repo.dir, maxGroups: 12, timeoutMs: 20000 });
    const plan = publicPlan(analysis.plan);

    const duplicated = { ...plan, groups: [...plan.groups, { ...plan.groups[0] }] };
    assert.throws(() => planFromSubmitted(duplicated, analysis.plan), (error) => error.code === 'stale');

    const missing = {
      ...plan,
      groups: plan.groups
        .map((group, index) =>
          index === plan.groups.length - 1 ? { ...group, files: group.files.slice(1) } : group,
        )
        .filter((group) => group.files.length > 0),
    };
    assert.throws(() => planFromSubmitted(missing, analysis.plan), (error) => error.code === 'stale');
    assert.throws(() => planFromSubmitted({ ...plan, groups: [] }, analysis.plan), (error) => error.code === 'stale');

    // The rule preview covers the tree, so it is still a valid submission.
    assert.equal(planFromSubmitted(plan, analysis.plan).length, plan.groups.length);
  } finally {
    await repo.cleanup();
  }
});

test('extractGroupPlan reads the agreed shape only', () => {
  const parsed = extractGroupPlan(
    '```json\n{"groups":[{"paths":[1,2],"type":"feat","scope":"a","message":"feat(a): x"}]}\n```',
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].paths, [1, 2]);
  assert.equal(parsed[0].type, 'feat');
  assert.equal(parsed[0].message, 'feat(a): x');
  const units = extractGroupPlan('{"groups":[{"units":[1,3],"type":"docs","message":"docs: x"}]}');
  assert.deepEqual(units[0].units, [1, 3]);
  assert.equal(extractGroupPlan('{"groups":[]}'), null);
  assert.equal(extractGroupPlan('no json here'), null);
  assert.equal(extractGroupPlan('{"messages":["a: b"]}'), null);
});

test('assertPlanMatches accepts edited messages and rejects a changed grouping', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({ gitBin: GIT, cwd: repo.dir, maxGroups: 6, timeoutMs: 20000 });
    const plan = publicPlan(analysis.plan);
    const edited = { ...plan, groups: plan.groups.map((group) => ({ ...group, message: 'docs: 改过' })) };
    assert.doesNotThrow(() => assertPlanMatches(edited, analysis.plan));
    const moved = {
      ...plan,
      groups: plan.groups.map((group, index) =>
        index === 0 ? { ...group, files: [...group.files, 'src/extra.js'] } : group,
      ),
    };
    assert.throws(() => assertPlanMatches(moved, analysis.plan), (error) => error.code === 'stale');
  } finally {
    await repo.cleanup();
  }
});

test('http route rejects non-POST, unauthenticated, unknown, and non-JSON requests', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const { api } = makeApi(repo.dir);
    const route = createRouteHandler(makeCtx(repo.dir), api);

    let res = fakeResponse();
    await route(fakeRequest({ method: 'GET' }), res);
    assert.equal(res.status, 405);

    res = fakeResponse();
    await route(fakeRequest({ body: { sessionId: SESSION } }), res);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);

    const denied = createRouteHandler(
      makeCtx(repo.dir, { admit: () => ({ rejection: 401 }) }),
      api,
    );
    res = fakeResponse();
    await denied(fakeRequest({}), res);
    assert.equal(res.status, 401);

    res = fakeResponse();
    await route(fakeRequest({ url: '/dsh-git-commit/nope' }), res);
    assert.equal(res.status, 404);

    res = fakeResponse();
    await route(fakeRequest({ contentType: 'text/plain' }), res);
    assert.equal(res.status, 415);
  } finally {
    await repo.cleanup();
  }
});

test('http route returns the analyze envelope for an authenticated owner', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const ctx = makeCtx(repo.dir);
    const api = createApi(ctx, resolveConfig({ gitPath: GIT }));
    const route = createRouteHandler(ctx, api);
    const res = fakeResponse();
    await route(fakeRequest({ body: { sessionId: SESSION } }), res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.value.plan.groups.length, 5);
    assert.equal(body.value.model, 'deepseek-official/deepseek-flash');
  } finally {
    await repo.cleanup();
  }
});

test('apply registers one authenticated prefix route on the web server', () => {
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const connection = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) };
  const registered = {
    webServer,
    connection,
    get(name) {
      if (name === 'webServer') return webServer;
      if (name === 'connection') return connection;
      return undefined;
    },
    inject(_names, callback) {
      callback(registered);
    },
    effect(callback) {
      return callback();
    },
    logger: { warn() {} },
  };
  apply(registered, { gitPath: GIT });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/dsh-git-commit');
  assert.equal(typeof routes[0].handler, 'function');
});

test('http route serializes a business failure as a 200 error envelope', async () => {
  const repo = await createRepo();
  try {
    const ctx = makeCtx(repo.dir);
    const api = createApi(ctx, resolveConfig({ gitPath: GIT }));
    const route = createRouteHandler(ctx, api);
    const res = fakeResponse();
    await route(fakeRequest({ body: { sessionId: SESSION } }), res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'clean');
    assert.match(body.error.message, /工作区干净/);
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

test('grouping input numbers every path, carries diff text, and honors the budget', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const analysis = await analyzeRepo({ gitBin: GIT, cwd: repo.dir, maxGroups: 12, timeoutMs: 20000 });
    const input = await buildGroupingInput(GIT, analysis.plan, {
      budget: 100000,
      timeoutMs: 20000,
      maxGroups: 12,
    });
    assert.match(input, /待提交文件：6 个/);
    assert.match(input, /^1\. /m);
    assert.match(input, /README\.md/);
    assert.match(input, /\[docs\]/);
    assert.match(input, /^\+更新说明/m);
    assert.match(input, /新文件 src\/app\.js/);

    // The numbering is the contract; when it cannot fit, the rules stay.
    assert.equal(await buildGroupingInput(GIT, analysis.plan, { budget: 200, timeoutMs: 20000 }), null);
    const bounded = await buildGroupingInput(GIT, analysis.plan, {
      budget: 1500,
      timeoutMs: 20000,
      maxGroups: 12,
    });
    assert.ok(bounded.length < 1800, `bounded input was ${bounded.length} chars`);

    // The repair prompt still describes each group it is asked to rename.
    const repairInput = await buildModelInput(GIT, analysis.plan, { budget: 100000, timeoutMs: 20000 });
    assert.match(repairInput, /共 5 组改动/);
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
  assert.equal(defaults.maxGroups, 12);

  const custom = resolveConfig({ gitPath: ' /usr/bin/git ', timeoutMs: -1, maxGroups: 0 });
  assert.equal(custom.gitPath, '/usr/bin/git');
  assert.equal(custom.timeoutMs, 20000);
  assert.equal(custom.maxGroups, 12);
});
