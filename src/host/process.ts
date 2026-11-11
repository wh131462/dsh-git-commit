/**
 * Process execution and git lock recovery.
 *
 * Every child runs without a shell, with a deadline, and with the prompts git
 * would otherwise wait for disabled. A repository lock left by a crashed git
 * is cleared only when no live process holds it.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readdir, readlink, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { DEFAULTS } from './config.js';

export interface ProcessResult {
  /** Exit code; `-1` when spawn itself failed or the deadline expired. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** The outcome of a lock probe or recovery attempt. */
export interface LockReport {
  status: 'none' | 'removed' | 'held' | 'unknown';
  path?: string;
  pids?: number[];
  ageMs?: number;
  error?: string;
}

/** A git result, plus the lock report when recovery was attempted. */
export type GitResult = ProcessResult & { lock?: LockReport };

/** Every message git prints when a repository lock is already taken or held. */
const LOCK_ERROR_RE =
  /(?:Unable to create '.*\.lock'|index\.lock|Another git process seems to be running)/i;
/** The path git itself names as the lock it could not create. */
const LOCK_PATH_RE = /Unable to create '([^']+)'/;
/** On platforms where no lock holder can be observed, age is the fallback. */
const LOCK_STALE_FALLBACK_MS = 10 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one command without a shell.
 * @param bin - executable.
 * @param args - full argument list.
 * @param options - optional stdin, timeout, and environment additions.
 * @returns `{ code, stdout, stderr }`; `code` is `-1` when spawn itself failed.
 */
export function runProcess(
  bin: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const { input, timeoutMs = DEFAULTS.timeoutMs, env } = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_MERGE_AUTOEDIT: 'no',
          ...(env ?? {}),
        },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: errorMessage(error) });
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stdout, stderr: `git 超时（${timeoutMs}ms）` });
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
 * Run one git command without a shell and without lock recovery.
 * @param bin - git executable.
 * @param cwd - directory that anchors `-C`.
 * @param args - arguments after `-C <cwd>`.
 * @param options - optional stdin, timeout, and environment additions.
 * @returns `{ code, stdout, stderr }`; `code` is `-1` when spawn itself failed.
 */
function runGitRaw(
  bin: string,
  cwd: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return runProcess(bin, ['-C', cwd, ...args], options);
}

/**
 * Resolve the index lock path for a working tree.
 *
 * `--git-path` answers for the worktree the command runs in, so a linked
 * worktree gets its own lock rather than the common directory's.
 *
 * @param bin - git executable.
 * @param cwd - repository directory.
 * @param timeoutMs - command timeout.
 * @returns an absolute path, or `null` when git cannot answer.
 */
async function indexLockPath(bin: string, cwd: string, timeoutMs: number): Promise<string | null> {
  const run = await runGitRaw(
    bin,
    cwd,
    ['-c', 'core.quotepath=false', 'rev-parse', '--git-path', 'index.lock'],
    { timeoutMs },
  );
  if (run.code !== 0) return null;
  const value = run.stdout.trim();
  if (value === '') return null;
  return isAbsolute(value) ? value : join(cwd, value);
}

/**
 * Probe whether an open descriptor still references the lock file.
 *
 * A git process keeps the lock's descriptor open for the whole write, so a
 * live holder is visible. `lsof` covers macOS and the BSDs, `/proc` covers
 * Linux; anywhere else the answer is `known: false` and age decides.
 *
 * @param lockPath - absolute lock path.
 * @returns `{ known, pids }` with numeric process ids.
 */
async function lockHolderPids(lockPath: string): Promise<{ known: boolean; pids: number[] }> {
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    const lsof = await runProcess('lsof', ['-t', lockPath], { timeoutMs: 3000 });
    if (lsof.code === 0) {
      const pids = lsof.stdout
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      return { known: true, pids: [...new Set(pids)].sort((a, b) => a - b) };
    }
    // 1 is lsof's "nothing matched"; an error on stderr means it could not see
    // every process, so the lock must not be treated as orphaned.
    const partial = lsof.code !== 1 || /permission denied/i.test(lsof.stderr);
    return partial ? { known: false, pids: [] } : { known: true, pids: [] };
  }
  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = await readdir('/proc');
    } catch {
      return { known: false, pids: [] };
    }
    const pids = new Set<number>();
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let fds: string[];
      try {
        fds = await readdir(`/proc/${entry}/fd`);
      } catch {
        continue; // another user's process, or it exited mid-scan
      }
      for (const fd of fds) {
        try {
          if ((await readlink(`/proc/${entry}/fd/${fd}`)) === lockPath) {
            pids.add(Number(entry));
            break;
          }
        } catch {
          /* the descriptor closed between readdir and readlink */
        }
      }
    }
    return { known: true, pids: [...pids].sort((a, b) => a - b) };
  }
  return { known: false, pids: [] };
}

/**
 * Clear the lock a crashed or killed git left behind, and only that one.
 *
 * A lock is removed only when no live process holds it open. When a holder is
 * found, or when the platform cannot prove the lock is orphaned and the file
 * is young, the lock is left in place and reported instead: deleting it then
 * would corrupt an index another git is writing.
 *
 * @param bin - git executable.
 * @param cwd - repository directory.
 * @param options - timeout, and the failing command's stderr to name the lock.
 * @returns a lock report with `status: 'none' | 'removed' | 'held' | 'unknown'`.
 */
export async function recoverGitLock(
  bin: string,
  cwd: string,
  { timeoutMs = DEFAULTS.timeoutMs, stderr = '' }: { timeoutMs?: number; stderr?: string } = {},
): Promise<LockReport> {
  const named = LOCK_PATH_RE.exec(stderr);
  let path = named === null ? null : named[1];
  if (path !== null && !isAbsolute(path)) path = join(cwd, path);
  if (path === null) path = await indexLockPath(bin, cwd, timeoutMs);
  if (path === null) return { status: 'none' };

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return { status: 'none', path };
  }
  const ageMs = Date.now() - info.mtimeMs;
  const holders = await lockHolderPids(path);
  if (holders.known && holders.pids.length > 0) {
    return { status: 'held', path, pids: holders.pids, ageMs };
  }
  if (!holders.known && ageMs < LOCK_STALE_FALLBACK_MS) {
    return { status: 'unknown', path, ageMs };
  }
  try {
    await unlink(path);
  } catch (error) {
    // Lost the race with the process that removed it: nothing left to recover.
    const code =
      error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return { status: 'none', path };
    return { status: 'unknown', path, ageMs, error: errorMessage(error) };
  }
  return { status: 'removed', path, ageMs };
}

/**
 * Run one git command, recovering once from a lock an interrupted git left.
 *
 * The recovery runs only after git reported a lock error, so a live lock is
 * never touched: `recoverGitLock` refuses to delete it and the caller decides
 * what to say. A successful second attempt is transparent to the caller.
 *
 * @param bin - git executable.
 * @param cwd - directory that anchors `-C`.
 * @param args - arguments after `-C <cwd>`.
 * @param options - optional stdin, timeout, and environment additions.
 * @returns the git result, plus `lock` when recovery was attempted.
 */
export async function runGit(
  bin: string,
  cwd: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<GitResult> {
  const first = await runGitRaw(bin, cwd, args, options);
  if (first.code === 0 || !LOCK_ERROR_RE.test(first.stderr)) return first;
  const lock = await recoverGitLock(bin, cwd, {
    timeoutMs: options.timeoutMs,
    stderr: first.stderr,
  });
  if (lock.status === 'held' || lock.status === 'unknown') return { ...first, lock };
  const retry = await runGitRaw(bin, cwd, args, options);
  return { ...retry, lock };
}

/**
 * Turn a lock probe into one actionable sentence for the dialog.
 * @param lock - `recoverGitLock`'s result, when recovery was attempted.
 * @returns an empty string, or a sentence that starts with a space.
 */
export function lockHint(lock: LockReport | null | undefined): string {
  if (lock === undefined || lock === null) return '';
  if (lock.status === 'held') {
    const pids = (lock.pids ?? []).join('、');
    return ` 该仓库正被另一个 git 进程（PID ${pids}）占用，等它结束后再试；不要手动删除 ${lock.path}。`;
  }
  if (lock.status === 'unknown') {
    return ` 无法确认 ${lock.path} 是残留锁还是仍在使用${lock.error ? `（${lock.error}）` : ''}，确认没有 git 进程后手动删除再试。`;
  }
  return '';
}
