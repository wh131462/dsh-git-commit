/**
 * Smart commit — SVN adapter.
 *
 * SVN has no staging area: a commit is a set of explicit working-copy paths
 * plus one message, and every plan group becomes one revision. New files must
 * be scheduled with `svn add` first — that is the only working-copy mutation
 * this module performs before committing, and a failed commit reverts exactly
 * the scheduling it created, keeping the file contents on disk.
 *
 * Everything here is probe-driven: `svn info` finds the working-copy root and
 * `svn status --xml` is parsed instead of the human-readable status, so paths
 * with spaces, quotes, or non-ASCII characters survive intact.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { type Dirent, existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import type { StatusEntry } from '../shared/contract.js';

const DEFAULT_TIMEOUT = 20000;
/** Never walk into these while expanding an unversioned directory. */
const SKIP_NAMES = new Set(['.svn', '.git', '.DS_Store', 'Thumbs.db', '__pycache__']);
/** A directory this large is almost certainly not meant to be added as-is. */
const WALK_LIMIT = 2000;
/**
 * UTF-8 locales that still speak English, most preferred first.
 *
 * Forcing `C` keeps svn's messages parseable, but it also gives svn an ASCII
 * native encoding: `svn add` then fails outright on non-ASCII paths
 * (`E000022: Can't convert string from native encoding to 'UTF-8'`), and log
 * text read back from the repository arrives as `{U+4E2D}`-style escapes.
 * `C.UTF-8` and `en_US.UTF-8` keep the untranslated messages this module
 * matches on while letting UTF-8 through untouched.
 */
const UTF8_LOCALES = ['C.UTF-8', 'en_US.UTF-8'];
/** Resolved once per process; `undefined` until the first svn spawn. */
let cachedLocale: string | undefined;

export interface SvnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SvnRunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
}

export interface SvnInfoData {
  root: string;
  url: string;
  branch: string;
  revision: number;
}

export type SvnInfoResult = ({ ok: true } & SvnInfoData) | { ok: false; error: string };

export interface SvnStatusData {
  entries: SvnEntry[];
  conflicts: string[];
  missing: string[];
  warnings: string[];
}

export type SvnStatusResult = ({ ok: true } & SvnStatusData) | { ok: false; error: string };

export type SvnEntry = StatusEntry;

export type SvnCommitResult =
  | { ok: true; revision: number; header: string }
  | { ok: false; error: string; undo?: string | null };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pick the first installed UTF-8 locale from {@link UTF8_LOCALES}.
 * @returns a locale name; the first candidate when `locale -a` cannot be read.
 */
function utf8Locale(): string {
  if (cachedLocale !== undefined) return cachedLocale;
  let installed: string[] = [];
  try {
    const probe = spawnSync('locale', ['-a'], { encoding: 'utf8' });
    if (probe.status === 0) {
      installed = String(probe.stdout)
        .split('\n')
        .map((name) => name.trim());
    }
  } catch {
    // No `locale` binary (Windows): the preferred candidate is still usable.
  }
  cachedLocale = UTF8_LOCALES.find((name) => installed.includes(name)) ?? UTF8_LOCALES[0];
  return cachedLocale;
}

/**
 * The environment every svn child gets: an English UTF-8 locale, and no
 * editor or merge tool prompts.
 * @param env - the caller's environment.
 * @returns a copy of `env` with the locale overridden.
 */
export function svnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const locale = utf8Locale();
  return {
    ...env,
    LC_ALL: locale,
    LANG: locale,
    LC_CTYPE: locale,
    SVN_EDITOR: 'true',
    SVN_MERGE: 'true',
  };
}

/**
 * Locate an svn binary that works even under a Finder-launched PATH.
 * @param configured - an explicit `svnPath`, or `''`.
 * @returns the executable to spawn.
 */
export function resolveSvn(configured: string): string {
  const candidates = [
    configured,
    process.env.SVN_PATH,
    '/usr/bin/svn',
    '/opt/homebrew/bin/svn',
    '/usr/local/bin/svn',
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  for (const candidate of candidates) {
    if (candidate === 'svn' || existsSync(candidate)) return candidate;
  }
  return 'svn';
}

/**
 * Run one svn command without a shell and without any interactive prompt.
 * @param bin - svn executable.
 * @param args - arguments after `--non-interactive`.
 * @param options - working directory, timeout, and optional stdin.
 * @returns `{ code, stdout, stderr }`; `code` is `-1` when spawn itself failed.
 */
export function runSvn(
  bin: string,
  args: readonly string[],
  options: SvnRunOptions = {},
): Promise<SvnResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT, input } = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: SvnResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, ['--non-interactive', ...args], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: svnEnv(),
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: errorMessage(error) });
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stdout, stderr: `svn 超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ code: -1, stdout, stderr: errorMessage(error) });
    });
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * Decode the five XML entities svn emits in attribute values and text nodes.
 * @param text - raw XML text.
 * @returns decoded text.
 */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    const code = entity.toLowerCase().startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

/**
 * Read the first text node of a tag.
 * @param xml - XML document.
 * @param tag - tag name.
 * @returns the decoded text, or `''`.
 */
function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match === null ? '' : decodeXml(match[1].trim());
}

/**
 * Parse `svn info --xml`.
 * @param xml - the document.
 * @returns `{ root, url, branch, revision }`, or `null` without a wc root.
 */
export function parseSvnInfoXml(xml: string): SvnInfoData | null {
  const root = tagText(xml, 'wcroot-abspath');
  if (root === '') return null;
  const url = tagText(xml, 'url');
  const relativeUrl = tagText(xml, 'relative-url').replace(/^\^\//u, '');
  const revision = /<entry\b[^>]*\brevision="(\d+)"/u.exec(xml);
  const branch = relativeUrl !== '' ? relativeUrl : (url.split('/').filter(Boolean).pop() ?? '');
  return {
    root,
    url,
    branch,
    revision: revision === null ? 0 : Number(revision[1]),
  };
}

/**
 * Find the working copy that contains `cwd`.
 * @param bin - svn executable.
 * @param cwd - directory to probe.
 * @param timeoutMs - deadline.
 * @returns info, or a failure description.
 */
export async function svnInfo(
  bin: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<SvnInfoResult> {
  const run = await runSvn(bin, ['info', '--xml'], { cwd, timeoutMs });
  if (run.code !== 0) {
    return { ok: false, error: (run.stderr || run.stdout).trim() };
  }
  const parsed = parseSvnInfoXml(run.stdout);
  if (parsed === null) return { ok: false, error: '无法解析 svn info 输出' };
  return { ok: true, ...parsed };
}

interface StatusBucket {
  entries: SvnEntry[];
  conflicts: string[];
  missing: string[];
  warnings: string[];
}

/**
 * Map one `wc-status` item to the two-character code the rest of the plugin
 * already understands, and note what must not be committed.
 * @param path - working-copy-relative path.
 * @param item - `item` attribute.
 * @param props - `props` attribute.
 * @param treeConflicted - whether `tree-conflicted="true"` is present.
 * @param bucket - collector arrays.
 */
function collectEntry(
  path: string,
  item: string,
  props: string,
  treeConflicted: boolean,
  bucket: StatusBucket,
): void {
  if (treeConflicted || item === 'conflicted') {
    bucket.conflicts.push(path);
    return;
  }
  switch (item) {
    case 'modified':
      bucket.entries.push({ code: props === 'modified' ? 'MM' : ' M', path });
      return;
    case 'added':
      bucket.entries.push({ code: 'A ', path });
      return;
    case 'deleted':
      bucket.entries.push({ code: ' D', path });
      return;
    case 'replaced':
      bucket.entries.push({ code: 'R ', path });
      return;
    case 'unversioned':
      bucket.entries.push({ code: '??', path, untracked: true });
      return;
    case 'missing':
      bucket.missing.push(path);
      return;
    case 'obstructed':
      bucket.warnings.push(`工作区条目被同名文件阻碍，已跳过：${path}`);
      return;
    case 'incomplete':
      bucket.warnings.push(`工作区条目不完整，已跳过：${path}`);
      return;
    case 'ignored':
    case 'external':
    case 'normal':
      // A property-only change still has item="normal" and props="modified".
      if (item === 'normal' && props === 'modified') {
        bucket.entries.push({ code: ' M', path });
      }
      return;
    default:
      bucket.warnings.push(`未识别的 SVN 状态 ${item}，已跳过：${path}`);
  }
}

/**
 * Turn one entry path into a working-copy-relative POSIX path.
 * @param root - working-copy root.
 * @param raw - the XML `path` attribute.
 * @returns the relative path.
 */
function relativePath(root: string, raw: string): string {
  const rel = isAbsolute(raw) ? relative(root, raw) : raw;
  return rel.split('\\').join('/');
}

/**
 * Parse `svn status --xml` into the plugin's entry shape.
 * @param xml - the document.
 * @param root - working-copy root, used to relativize absolute paths.
 * @returns `{ entries, conflicts, missing, warnings }`.
 */
export function parseSvnStatusXml(xml: string, root = ''): SvnStatusData {
  const bucket: StatusBucket = { entries: [], conflicts: [], missing: [], warnings: [] };
  const entryRe = /<entry\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/gu;
  for (let match = entryRe.exec(xml); match !== null; match = entryRe.exec(xml)) {
    const path = relativePath(root, decodeXml(match[1]));
    if (path === '') continue;
    const status = /<wc-status\b([^>]*)>/u.exec(match[2]);
    if (status === null) continue;
    const attrs = status[1];
    const item = /\bitem="([^"]*)"/u.exec(attrs)?.[1] ?? 'normal';
    const props = /\bprops="([^"]*)"/u.exec(attrs)?.[1] ?? 'none';
    const treeConflicted = /\btree-conflicted="true"/u.test(attrs);
    collectEntry(path, item, props, treeConflicted, bucket);
  }
  return bucket;
}

/**
 * Whether a working-copy-relative path is a directory on disk.
 * @param root - working-copy root.
 * @param path - relative path.
 * @returns true for directories.
 */
async function isDirectory(root: string, path: string): Promise<boolean> {
  try {
    const info = await lstat(join(root, path));
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * List the files under an unversioned directory, bounded and skipping the
 * metadata directories no commit ever wants.
 * @param root - working-copy root.
 * @param path - unversioned directory, relative to the root.
 * @returns `{ files, truncated }`.
 */
async function walkUnversioned(
  root: string,
  path: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const pending = [path];
  while (pending.length > 0 && !truncated) {
    const current = pending.pop();
    if (current === undefined) break;
    let children: Dirent<string>[];
    try {
      children = await readdir(join(root, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (SKIP_NAMES.has(child.name)) continue;
      const childPath = `${current}/${child.name}`;
      // A symlink is committed as a link, never walked into.
      if (child.isDirectory()) pending.push(childPath);
      else if (child.isFile() || child.isSymbolicLink()) files.push(childPath);
      if (files.length > WALK_LIMIT) {
        truncated = true;
        break;
      }
    }
  }
  files.sort();
  return { files, truncated };
}

/**
 * Read the whole status of a working copy, expanding unversioned directories
 * into their files so grouping, counting, and the sensitive filter see files
 * rather than an opaque directory.
 * @param bin - svn executable.
 * @param root - working-copy root.
 * @param timeoutMs - deadline.
 * @returns `{ ok, entries, conflicts, missing, warnings }`.
 */
export async function svnStatus(
  bin: string,
  root: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<SvnStatusResult> {
  const run = await runSvn(bin, ['status', '--xml', '--ignore-externals'], {
    cwd: root,
    timeoutMs,
  });
  if (run.code !== 0) {
    return { ok: false, error: (run.stderr || run.stdout).trim() };
  }
  const parsed = parseSvnStatusXml(run.stdout, root);
  const entries: SvnEntry[] = [];
  for (const entry of parsed.entries) {
    if (entry.untracked !== true || !(await isDirectory(root, entry.path))) {
      entries.push(entry);
      continue;
    }
    const { files, truncated } = await walkUnversioned(root, entry.path);
    if (truncated) {
      parsed.warnings.push(
        `未版本化目录 ${entry.path} 的文件超过 ${WALK_LIMIT} 个，已跳过；请先手动 svn add 需要的文件。`,
      );
      continue;
    }
    if (files.length === 0) {
      parsed.warnings.push(`未版本化目录为空，已跳过：${entry.path}`);
      continue;
    }
    for (const file of files) entries.push({ code: '??', path: file, untracked: true });
  }
  return {
    ok: true,
    entries,
    conflicts: parsed.conflicts,
    missing: parsed.missing,
    warnings: parsed.warnings,
  };
}

/**
 * Parse the `A  path` lines `svn add` prints, which are exactly the nodes this
 * run scheduled (including parent directories added by `--parents`).
 * @param stdout - the command's output.
 * @returns scheduled working-copy-relative paths.
 */
export function parseAddOutput(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^A\s+(.+?)\s*$/u.exec(line);
    if (match !== null) paths.push(match[1].split('\\').join('/'));
  }
  return paths;
}

/**
 * Undo only the scheduling this run created.
 *
 * `svn revert` on a scheduled add keeps the file on disk. Directories are the
 * delicate case: reverting one with `--depth empty` fails while its children
 * are still scheduled, and reverting it recursively could unschedule work the
 * user added by hand. So children are reverted first, deepest path first, and
 * a directory that still has foreign scheduled children is left alone and
 * reported instead of being reverted over.
 *
 * @param bin - svn executable.
 * @param root - working-copy root.
 * @param paths - paths returned by `parseAddOutput`.
 * @param timeoutMs - deadline.
 * @returns `null` on success, or a failure description.
 */
export async function revertAdded(
  bin: string,
  root: string,
  paths: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<string | null> {
  const unique = [...new Set(paths)].filter((path) => path !== '');
  if (unique.length === 0) return null;
  const byDepth = new Map<number, string[]>();
  for (const path of unique) {
    const depth = path.split('/').length;
    const batch = byDepth.get(depth);
    if (batch === undefined) byDepth.set(depth, [path]);
    else batch.push(path);
  }
  const failures: string[] = [];
  for (const depth of [...byDepth.keys()].sort((left, right) => right - left)) {
    const run = await runSvn(
      bin,
      ['revert', '--depth', 'empty', '--', ...(byDepth.get(depth) ?? [])],
      { cwd: root, timeoutMs },
    );
    if (run.code !== 0) failures.push((run.stderr || run.stdout).trim());
  }
  return failures.length === 0 ? null : failures.join('；');
}

/**
 * Commit one group and report the new revision.
 * @param bin - svn executable.
 * @param root - working-copy root.
 * @param files - the group's paths.
 * @param message - a validated commit message.
 * @param untracked - paths the analysis saw as unversioned.
 * @param timeoutMs - deadline.
 * @returns `{ ok, revision, header, error, undo }`; `undo` is `null` when the
 *   working copy is as it was, or the failure that prevented restoring it.
 */
export async function svnCommitGroup(
  bin: string,
  root: string,
  files: readonly string[],
  message: string,
  untracked: readonly string[] = [],
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<SvnCommitResult> {
  const known = new Set(untracked);
  const toAdd = files.filter((path) => known.has(path));
  let added: string[] = [];
  if (toAdd.length > 0) {
    const add = await runSvn(bin, ['add', '--parents', '--depth', 'empty', '--', ...toAdd], {
      cwd: root,
      timeoutMs,
    });
    added = parseAddOutput(add.stdout);
    if (add.code !== 0) {
      const text = (add.stderr || add.stdout).trim();
      // Already scheduled by someone else is not a failure: the path is simply
      // another commit target.
      if (!/already under version control/u.test(text)) {
        const undo = added.length > 0 ? await revertAdded(bin, root, added, timeoutMs) : undefined;
        return { ok: false, error: `svn add 失败——${text}`, undo };
      }
    }
  }

  const targets = [...new Set([...files, ...added])];
  let directory: string | undefined;
  let failure: string | undefined;
  let revision: number | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'dsh-smart-commit-'));
    const file = join(directory, 'message.txt');
    await writeFile(file, message, 'utf8');
    const commit = await runSvn(
      bin,
      ['commit', '--encoding', 'UTF-8', '-F', file, '--', ...targets],
      { cwd: root, timeoutMs },
    );
    if (commit.code !== 0) {
      failure = (commit.stderr || commit.stdout).trim();
    } else {
      const match = /Committed revision (\d+)\./u.exec(commit.stdout);
      revision = match === null ? 0 : Number(match[1]);
    }
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (failure !== undefined) {
    // Keep the working copy as the user left it: unschedule only what we added.
    const undo = added.length > 0 ? await revertAdded(bin, root, added, timeoutMs) : undefined;
    return { ok: false, error: failure, undo };
  }
  return { ok: true, revision: revision ?? 0, header: message.split('\n')[0] };
}

/**
 * The working tree left after a commit, as one line per item.
 * @param bin - svn executable.
 * @param root - working-copy root.
 * @param timeoutMs - deadline.
 * @returns display lines.
 */
export async function svnRemaining(
  bin: string,
  root: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<string[]> {
  // No expansion here: this only lists what is left, it never plans a commit.
  const run = await runSvn(bin, ['status', '--xml', '--ignore-externals'], {
    cwd: root,
    timeoutMs,
  });
  if (run.code !== 0) return [];
  return parseSvnStatusXml(run.stdout, root).entries.map((entry) => `${entry.code} ${entry.path}`);
}

/**
 * A bounded diff for the model prompt.
 * @param bin - svn executable.
 * @param root - working-copy root.
 * @param files - versioned paths in one group.
 * @param timeoutMs - deadline.
 * @returns diff text, or `''` when svn cannot produce one.
 */
export async function svnDiff(
  bin: string,
  root: string,
  files: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<string> {
  if (files.length === 0) return '';
  const run = await runSvn(bin, ['diff', '--internal-diff', '--', ...files], {
    cwd: root,
    timeoutMs,
  });
  return run.code === 0 ? run.stdout : '';
}
