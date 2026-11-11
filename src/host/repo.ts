/**
 * Working-tree analysis: turn `git status` / `svn status` into a plan.
 *
 * `auto` prefers Git: a directory that is both a Git and an SVN working copy
 * (a git-svn checkout, for example) is committed through git, because that is
 * where the history the Session sees lives.
 */

import type { StatusEntry, VcsKind } from '../shared/contract.js';
import type { Plan } from './dsh.js';
import { groupEntries, parseStatus } from './plan.js';
import { lockHint, runGit } from './process.js';
import { resolveSvn, svnInfo, svnStatus } from './svn.js';

export interface AnalyzeOptions {
  gitBin: string;
  /** Defaults to probing the usual install locations. */
  svnBin?: string;
  cwd: string;
  timeoutMs: number;
  /** `auto` prefers Git and only falls back to SVN. */
  vcs?: 'auto' | VcsKind;
}

export type AnalyzeResult =
  | { ok: true; plan: Plan }
  | {
      ok: false;
      text: string;
      /** The working tree has no changes. */
      clean?: boolean;
      /** Only sensitive paths were left after filtering. */
      sensitive?: boolean;
      /** Neither git nor svn recognizes the directory. */
      notRepo?: boolean;
    };

/**
 * Inspect a working tree and build a commit plan.
 * @param options - binaries, directory, limits, and the `auto|git|svn` mode.
 * @returns a plan, or a failure description (with `notRepo` when nothing matched).
 */
export async function analyzeRepo(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const mode = options.vcs ?? 'git';
  if (mode === 'svn') return analyzeSvnRepo(options);
  if (mode === 'git') return analyzeGitRepo(options);
  const git = await analyzeGitRepo(options);
  if (git.ok || git.notRepo !== true) return git;
  const svn = await analyzeSvnRepo(options);
  if (svn.ok) return svn;
  return {
    ok: false,
    notRepo: true,
    text: '当前目录既不是 Git 仓库，也不在 SVN 工作副本中，未做任何改动。',
  };
}

/**
 * Build a plan from a Git working tree.
 * @param options - git binary, repository directory, limits.
 * @returns a plan, or a failure description.
 */
export async function analyzeGitRepo({
  gitBin,
  cwd,
  timeoutMs,
}: Pick<AnalyzeOptions, 'gitBin' | 'cwd' | 'timeoutMs'>): Promise<AnalyzeResult> {
  const top = await runGit(gitBin, cwd, ['rev-parse', '--show-toplevel'], { timeoutMs });
  if (top.code !== 0) {
    return { ok: false, notRepo: true, text: '当前目录不是 Git 仓库，未做任何改动。' };
  }
  const toplevel = top.stdout.trim();
  const head = await runGit(gitBin, toplevel, ['rev-parse', '--verify', '-q', 'HEAD'], {
    timeoutMs,
  });
  const branchRun = await runGit(gitBin, toplevel, ['symbolic-ref', '--short', '-q', 'HEAD'], {
    timeoutMs,
  });
  const branch = branchRun.code === 0 ? branchRun.stdout.trim() : 'HEAD';
  const status = await runGit(
    gitBin,
    toplevel,
    ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '--untracked-files=all'],
    { timeoutMs },
  );
  if (status.code !== 0) {
    return {
      ok: false,
      text: `读取 git status 失败：${status.stderr.trim()}${lockHint(status.lock)}`,
    };
  }
  const entries = parseStatus(status.stdout);
  if (entries.length === 0) {
    return { ok: false, clean: true, text: '工作区干净，没有可提交的改动。' };
  }
  const { groups, skipped } = groupEntries(entries);
  if (groups.length === 0) {
    return {
      ok: false,
      clean: true,
      sensitive: true,
      text: '只剩敏感文件，已全部跳过，没有可提交的内容。',
    };
  }
  // A non-empty index cannot be committed over without mixing in staged work;
  // the plan carries the exact paths so the dialog can offer to unstage them.
  const stagedRun = await runGit(gitBin, toplevel, ['diff', '--cached', '--name-only', '-z'], {
    timeoutMs,
  });
  const staged = stagedRun.stdout.split('\0').filter((path) => path !== '');
  return {
    ok: true,
    plan: {
      vcs: 'git',
      cwd: toplevel,
      branch,
      hasHead: head.code === 0,
      staged,
      groups,
      // Kept host-side only: the model prompt shows each path's status code.
      entries,
      skipped,
      at: Date.now(),
    },
  };
}

/**
 * Build a plan from an SVN working copy.
 *
 * SVN has no index, so nothing can be "already staged": the plan only records
 * which paths are unversioned, because those are the ones `svn add` has to
 * schedule at commit time.
 *
 * @param options - svn binary, directory, limits.
 * @returns a plan, or a failure description.
 */
export async function analyzeSvnRepo({
  svnBin,
  cwd,
  timeoutMs,
}: Omit<AnalyzeOptions, 'vcs' | 'gitBin'>): Promise<AnalyzeResult> {
  const bin = svnBin === undefined || svnBin === '' ? resolveSvn('') : svnBin;
  const info = await svnInfo(bin, cwd, timeoutMs);
  if (!info.ok) {
    return { ok: false, notRepo: true, text: '当前目录不在 SVN 工作副本中，未做任何改动。' };
  }
  const status = await svnStatus(bin, info.root, timeoutMs);
  if (!status.ok) {
    return { ok: false, text: `读取 svn status 失败：${status.error}` };
  }
  if (status.conflicts.length > 0) {
    return {
      ok: false,
      text: [
        '工作副本存在未解决的冲突，先处理并执行 svn resolve 后再提交：',
        ...status.conflicts.map((path) => `   ! ${path}`),
      ].join('\n'),
    };
  }
  if (status.entries.length === 0) {
    return { ok: false, clean: true, text: '工作区干净，没有可提交的改动。' };
  }
  const { groups, skipped } = groupEntries(status.entries);
  if (groups.length === 0) {
    return {
      ok: false,
      clean: true,
      sensitive: true,
      text: '只剩敏感文件，已全部跳过，没有可提交的内容。',
    };
  }
  const warnings = [...status.warnings];
  if (status.missing.length > 0) {
    warnings.push(
      `工作区有 ${status.missing.length} 个文件缺失（未执行 svn delete），已跳过：${status.missing
        .slice(0, 10)
        .join('、')}${status.missing.length > 10 ? ' 等' : ''}`,
    );
  }
  const entries: StatusEntry[] = status.entries;
  return {
    ok: true,
    plan: {
      vcs: 'svn',
      cwd: info.root,
      branch: info.branch,
      hasHead: true,
      revision: info.revision,
      staged: [],
      groups,
      entries,
      skipped,
      warnings,
      untracked: entries.filter((entry) => entry.untracked === true).map((entry) => entry.path),
      added: entries.filter((entry) => entry.code === 'A ').map((entry) => entry.path),
      at: Date.now(),
    },
  };
}
