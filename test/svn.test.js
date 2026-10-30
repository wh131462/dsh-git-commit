import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  analyzeRepo,
  buildModelInput,
  commitPlan,
  createApi,
  publicPlan,
  resolveConfig,
} from '../index.js';
import {
  parseAddOutput,
  parseSvnInfoXml,
  parseSvnStatusXml,
  svnCommitGroup,
  svnStatus,
} from '../svn.js';

const exec = promisify(execFile);
const GIT = 'git';
const SVN = process.env.SVN_BIN ?? 'svn';
const SVNADMIN = process.env.SVNADMIN_BIN ?? 'svnadmin';
const SVNLOOK = process.env.SVNLOOK_BIN ?? 'svnlook';
const HAS_SVN =
  spawnSync(SVN, ['--version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(SVNADMIN, ['--version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(SVNLOOK, ['--version'], { stdio: 'ignore' }).status === 0;

/** A filename that exercises XML escaping, spaces, and non-ASCII text. */
const ODD_PATH = 'dir with space/中文 & 符号.txt';

/**
 * Create a repository plus a checkout with one initial commit.
 * @returns `{ root, repo, wc, cleanup }`.
 */
async function createSvnWorkingCopy() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sc-svn-'));
  const repo = join(root, 'repo');
  const wc = join(root, 'wc');
  await exec(SVNADMIN, ['create', repo]);
  await exec(SVN, ['checkout', pathToFileURL(repo).href, wc]);
  await mkdir(join(wc, 'src'));
  await writeFile(join(wc, 'README.md'), '# Repo\n', 'utf8');
  await writeFile(join(wc, 'src', 'app.js'), 'export const app = 1;\n', 'utf8');
  await exec(SVN, ['add', '--parents', 'README.md', 'src/app.js'], { cwd: wc });
  await exec(SVN, ['commit', '-m', 'docs: 初始化 README'], { cwd: wc });
  return {
    root,
    repo,
    wc,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Apply one representative change set to a working copy.
 * @param wc - the checkout.
 */
async function populate(wc) {
  await writeFile(join(wc, 'README.md'), '# Repo\n\n更新说明。\n', 'utf8');
  await writeFile(join(wc, 'src', 'util.js'), 'export const util = 2;\n', 'utf8');
  await mkdir(join(wc, 'docs'), { recursive: true });
  await writeFile(join(wc, 'docs', 'guide.md'), '# Guide\n', 'utf8');
  await mkdir(join(wc, 'pkg', 'deep'), { recursive: true });
  await writeFile(join(wc, 'pkg', 'deep', 'new.js'), 'export const fresh = 1;\n', 'utf8');
  await writeFile(join(wc, 'pkg', '.env'), 'SECRET=1\n', 'utf8');
}

/**
 * The repository's youngest revision.
 *
 * `svn log` inside a working copy is pegged at the root directory's revision,
 * which can lag behind file revisions; `svnlook` reads the repository itself.
 *
 * @param repo - repository path.
 * @returns the youngest revision number.
 */
async function youngest(repo) {
  const { stdout } = await exec(SVNLOOK, ['youngest', repo]);
  return Number(stdout.trim());
}

test('parses svn info and finds the branch label', () => {
  const xml = `<?xml version="1.0"?>
<info>
<entry kind="dir" path="." revision="7">
<url>https://svn.example.com/repo/trunk/app</url>
<relative-url>^/trunk/app</relative-url>
<repository><root>https://svn.example.com/repo</root></repository>
<wc-info><wcroot-abspath>/work/app</wcroot-abspath><schedule>normal</schedule></wc-info>
</entry>
</info>`;
  assert.deepEqual(parseSvnInfoXml(xml), {
    root: '/work/app',
    url: 'https://svn.example.com/repo/trunk/app',
    branch: 'trunk/app',
    revision: 7,
  });
  // A checkout of the repository root has no relative path beyond "^/".
  const atRoot = xml
    .replace('^/trunk/app', '^/')
    .replace('https://svn.example.com/repo/trunk/app', 'https://svn.example.com/repo');
  assert.equal(parseSvnInfoXml(atRoot).branch, 'repo');
  assert.equal(parseSvnInfoXml('<info></info>'), null);
});

test('parses svn status xml, including escaping and property changes', () => {
  const xml = `<?xml version="1.0"?>
<status>
<target path=".">
<entry path="src/a.js"><wc-status item="modified" revision="3" props="none"></wc-status></entry>
<entry path="src/prop.js"><wc-status item="modified" revision="3" props="modified"></wc-status></entry>
<entry path="src/new.js"><wc-status item="added" revision="-1" props="none"></wc-status></entry>
<entry path="src/gone.js"><wc-status item="deleted" revision="3" props="none"></wc-status></entry>
<entry path="a &amp; b.txt"><wc-status item="unversioned" props="none"></wc-status></entry>
<entry path="src/conflict.js"><wc-status item="conflicted" revision="3" props="none"></wc-status></entry>
<entry path="src/absent.js"><wc-status item="missing" revision="3" props="none"></wc-status></entry>
<entry path="src/tree.js"><wc-status item="modified" revision="3" props="none" tree-conflicted="true"></wc-status></entry>
<entry path="vendor"><wc-status item="external" props="none"></wc-status></entry>
</target>
</status>`;
  const parsed = parseSvnStatusXml(xml, '');
  assert.deepEqual(parsed.entries, [
    { code: ' M', path: 'src/a.js' },
    { code: 'MM', path: 'src/prop.js' },
    { code: 'A ', path: 'src/new.js' },
    { code: ' D', path: 'src/gone.js' },
    { code: '??', path: 'a & b.txt', untracked: true },
  ]);
  assert.deepEqual(parsed.conflicts, ['src/conflict.js', 'src/tree.js']);
  assert.deepEqual(parsed.missing, ['src/absent.js']);
  assert.deepEqual(parsed.warnings, []);
});

test('parses svn add output, including paths with spaces', () => {
  assert.deepEqual(
    parseAddOutput(`A         pkg\nA         pkg/deep\nA         pkg/deep/new.js\nA         ${ODD_PATH}\n`),
    ['pkg', 'pkg/deep', 'pkg/deep/new.js', ODD_PATH],
  );
  assert.deepEqual(parseAddOutput("svn: warning: W150002: 'x' is already under version control\n"), []);
});

test('keeps the VCS marker in the wire plan', () => {
  const plan = publicPlan({
    vcs: 'svn',
    branch: 'trunk',
    hasHead: true,
    staged: [],
    skipped: ['.env'],
    warnings: ['工作区条目被同名文件阻碍，已跳过：x'],
    groups: [{ type: 'feat', scope: 'pkg', message: 'feat(pkg): 新增文件', files: ['pkg/a.js', 'pkg/b.js'] }],
  });
  assert.equal(plan.vcs, 'svn');
  assert.equal(plan.branch, 'trunk');
  assert.deepEqual(plan.staged, []);
  assert.deepEqual(plan.skipped, ['.env']);
  assert.equal(plan.groups[0].message, 'feat(pkg): 新增文件');
  assert.deepEqual(plan.warnings, ['工作区条目被同名文件阻碍，已跳过：x']);
});

test('config accepts vcs and svnPath', () => {
  const defaults = resolveConfig(undefined);
  assert.equal(defaults.vcs, 'auto');
  assert.equal(defaults.svnPath, '');

  const pinned = resolveConfig({ vcs: 'svn', svnPath: ' /opt/homebrew/bin/svn ' });
  assert.equal(pinned.vcs, 'svn');
  assert.equal(pinned.svnPath, '/opt/homebrew/bin/svn');

  // Anything else falls back to auto instead of disabling commits entirely.
  assert.equal(resolveConfig({ vcs: 'hg' }).vcs, 'auto');
});

test('analyzes and commits a real SVN working copy', { skip: !HAS_SVN }, async () => {
  const repo = await createSvnWorkingCopy();
  try {
    await populate(repo.wc);
    const analysis = await analyzeRepo({
      vcs: 'auto',
      gitBin: GIT,
      svnBin: SVN,
      cwd: repo.wc,
      maxGroups: 6,
      timeoutMs: 20000,
    });
    assert.equal(analysis.ok, true, analysis.text);
    const { plan } = analysis;
    assert.equal(plan.vcs, 'svn');
    assert.equal(plan.cwd, await realpath(repo.wc));
    assert.equal(plan.branch, 'repo');
    assert.deepEqual(plan.staged, []);
    assert.deepEqual(plan.skipped, ['pkg/.env']);
    // The unversioned directory is expanded to the file, not committed as one blob.
    assert.ok(plan.untracked.includes('pkg/deep/new.js'));
    assert.equal(plan.groups.flatMap((group) => group.files).includes('pkg/deep/new.js'), true);

    const input = await buildModelInput(SVN, plan, { budget: 50000, timeoutMs: 20000 });
    assert.match(input, /（SVN）/);
    assert.match(input, /更新说明/);
    assert.match(input, /新文件 pkg\/deep\/new\.js/);

    const before = await youngest(repo.repo);
    const messages = plan.groups.map((group) => group.message);
    messages[0] = 'docs: 补充 README 说明';
    const outcome = await commitPlan(plan, messages, { svnBin: SVN, timeoutMs: 20000 });
    assert.equal(outcome.ok, true, outcome.text);
    assert.match(outcome.text, /提交完成：\d+ 组/);
    assert.match(outcome.text, /OK 1\. r\d+/);
    assert.equal(await youngest(repo.repo), before + plan.groups.length);

    const status = await exec(SVN, ['status'], { cwd: repo.wc });
    assert.equal(status.stdout.trim(), '?       pkg/.env');
    const log = await exec(SVNLOOK, ['log', '-r', String(before + 1), repo.repo]);
    assert.match(log.stdout, /docs: 补充 README 说明/);
  } finally {
    await repo.cleanup();
  }
});

test('sends a pinned SVN adapter through the API', { skip: !HAS_SVN }, async () => {
  const repo = await createSvnWorkingCopy();
  try {
    await populate(repo.wc);
    const session = {
      header: { cwd: repo.wc },
      requestHeader: () => ({
        config: { provider: 'deepseek-official', model: 'deepseek-flash' },
      }),
    };
    const ctx = {
      get(name) {
        if (name === 'sessions') return { get: (id) => (id === 'svn-session' ? session : undefined) };
        if (name === 'workingDirectory') return { get: (value) => value.header.cwd };
        if (name === 'llm') return autoLlm();
        return undefined;
      },
      logger: { warn() {} },
    };
    const api = createApi(ctx, resolveConfig({ vcs: 'svn', svnPath: SVN }));
    const analyzed = await api.analyze({ sessionId: 'svn-session' });
    assert.equal(analyzed.plan.vcs, 'svn');
    assert.ok(analyzed.plan.groups.length >= 1);

    const named = await api.name({ sessionId: 'svn-session' });
    const committed = await api.commit({
      sessionId: 'svn-session',
      plan: named.plan,
      messages: named.messages,
      unstage: false,
    });
    assert.equal(committed.ok, true, committed.text);
    assert.match(committed.text, /提交完成/);
    assert.ok((await youngest(repo.repo)) >= 2);
  } finally {
    await repo.cleanup();
  }
});

test('refuses to analyze a conflicted working copy', { skip: !HAS_SVN }, async () => {
  const repo = await createSvnWorkingCopy();
  const other = join(repo.root, 'other');
  try {
    await exec(SVN, ['checkout', pathToFileURL(repo.repo).href, other]);
    await writeFile(join(other, 'README.md'), '# Repo\n\n来自另一处。\n', 'utf8');
    await exec(SVN, ['commit', '-m', 'docs: 另一处修改'], { cwd: other });

    await writeFile(join(repo.wc, 'README.md'), '# Repo\n\n本地修改。\n', 'utf8');
    await exec(SVN, ['--non-interactive', 'update'], { cwd: repo.wc }).catch(() => {});

    const analysis = await analyzeRepo({
      vcs: 'svn',
      svnBin: SVN,
      cwd: repo.wc,
      maxGroups: 6,
      timeoutMs: 20000,
    });
    assert.equal(analysis.ok, false);
    assert.match(analysis.text, /冲突/);
    assert.match(analysis.text, /svn resolve/);
  } finally {
    await repo.cleanup();
  }
});

test('unschedules only its own added paths when a commit fails', { skip: !HAS_SVN }, async () => {
  const repo = await createSvnWorkingCopy();
  try {
    await mkdir(join(repo.wc, 'new', 'deep'), { recursive: true });
    await writeFile(join(repo.wc, 'new', 'deep', 'n.js'), 'export const n = 1;\n', 'utf8');
    const hook = join(repo.repo, 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho "blocked by test hook" >&2\nexit 1\n', 'utf8');
    await chmod(hook, 0o755);

    const result = await svnCommitGroup(
      SVN,
      repo.wc,
      ['new/deep/n.js'],
      'feat(new): 新增文件',
      ['new/deep/n.js'],
      20000,
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /blocked by test hook/u);
    assert.equal(result.undo, null);

    const status = await svnStatus(SVN, repo.wc, 20000);
    assert.deepEqual(
      status.entries.map((entry) => entry.code),
      ['??'],
    );
    assert.equal(await readFile(join(repo.wc, 'new', 'deep', 'n.js'), 'utf8'), 'export const n = 1;\n');
  } finally {
    await repo.cleanup();
  }
});

test('reports a directory that is neither Git nor SVN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sc-novcs-'));
  try {
    const analysis = await analyzeRepo({
      vcs: 'auto',
      gitBin: GIT,
      svnBin: SVN,
      cwd: dir,
      maxGroups: 6,
      timeoutMs: 10000,
    });
    assert.equal(analysis.ok, false);
    assert.match(analysis.text, /既不是 Git 仓库，也不在 SVN 工作副本中/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A stub LLM answering with the number of groups the prompt asked for. */
function autoLlm() {
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }] } };
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
