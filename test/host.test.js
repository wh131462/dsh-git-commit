import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import {
  analyzeRepo,
  apply,
  assertPlanMatches,
  buildHeader,
  buildModelInput,
  classify,
  commitPlan,
  createApi,
  createRouteHandler,
  extractMessages,
  groupEntries,
  isSensitive,
  normalizeMessage,
  parseStatus,
  publicPlan,
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

test('api.name fills every group in one model call', async () => {
  const repo = await createRepo();
  try {
    await populate(repo.dir);
    const generated = Array.from({ length: 5 }, (_, index) => `refactor(model): 模型生成 message ${index + 1}`);
    const { api } = makeApi(repo.dir, { llm: fakeLlm(JSON.stringify({ messages: generated })) });
    const named = await api.name({ sessionId: SESSION });
    assert.deepEqual(named.messages, generated);
    assert.equal(named.failures.length, 0);
    assert.match(named.note, /生成了全部 5 条 message/);
    assert.match(named.plan.groups[0].message, /模型生成/);
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

test('api.name repairs invalid headers in one targeted round', async () => {
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
    const { api } = makeApi(repo.dir, { llm: fakeLlm([first, repaired]) });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 0);
    assert.match(named.note, /生成了全部 5 条 message/);
    assert.ok(named.messages.includes('ci: 调整流水线'));
    assert.ok(named.messages.includes('feat(agent): 新增文档生成能力'));
  } finally {
    await repo.cleanup();
  }
});

test('api.name leaves a still-invalid group empty instead of guessing', async () => {
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
    const { api } = makeApi(repo.dir, { llm: fakeLlm([first, repaired]) });
    const named = await api.name({ sessionId: SESSION });
    assert.equal(named.failures.length, 1);
    assert.equal(named.messages[0], '');
    assert.match(named.note, /1 组还没有可用的模型 message/);
    assert.match(named.note, /chore/);
  } finally {
    await repo.cleanup();
  }
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
