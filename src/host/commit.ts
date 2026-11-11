/**
 * Commit execution for both VCS adapters.
 *
 * Git commits one group at a time over explicit paths, releasing this run's
 * own staging on failure. SVN commits explicit paths and one revision per
 * group, unscheduling only the `svn add` calls this run made.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Plan } from './dsh.js';
import { validateMessage } from './plan.js';
import { type GitResult, type LockReport, lockHint, runGit } from './process.js';
import { resolveSvn, svnCommitGroup, svnRemaining } from './svn.js';

export interface CommitOptions {
  gitBin: string;
  svnBin: string;
  timeoutMs: number;
}

export interface CommitOutcome {
  ok: boolean;
  text: string;
}

/**
 * Commit one plan group by group, stopping at the first failure.
 * @param plan - the plan to execute.
 * @param messages - one validated message per group.
 * @param options - binaries and timeout; the binary matching `plan.vcs` is used.
 * @returns the outcome text and whether every group committed.
 */
export async function commitPlan(
  plan: Plan,
  messages: readonly string[],
  options: CommitOptions,
): Promise<CommitOutcome> {
  if (plan.vcs === 'svn') return commitSvnPlan(plan, messages, options);
  return commitGitPlan(plan, messages, options);
}

/**
 * Commit a Git plan, one group per commit.
 * @param plan - the plan to execute.
 * @param messages - one validated message per group.
 * @param options - git binary and timeout.
 * @returns the outcome text and whether every group committed.
 */
async function commitGitPlan(
  plan: Plan,
  messages: readonly string[],
  { gitBin, timeoutMs }: Pick<CommitOptions, 'gitBin' | 'timeoutMs'>,
): Promise<CommitOutcome> {
  const done: string[] = [];
  const lines: string[] = [];

  /** Move this run's own staging back out of the index, keeping the work. */
  const rollback = async (
    paths: readonly string[],
    index: number,
  ): Promise<GitResult | undefined> => {
    if (paths.length === 0) return undefined;
    const restore = await runGit(gitBin, plan.cwd, ['restore', '--staged', '--', ...paths], {
      timeoutMs,
    });
    const hint = lockHint(restore.lock);
    lines.push(
      restore.code === 0
        ? `已把第 ${index + 1} 组移出暂存区，改动仍保留在工作区。`
        : hint !== ''
          ? `⚠ 第 ${index + 1} 组暂时留在暂存区，改动没有丢失。${hint.trim()}`
          : `⚠ 第 ${index + 1} 组移出暂存区失败，请手动执行 git restore --staged -- <path>：${restore.stderr.trim()}`,
    );
    return restore;
  };

  for (let index = 0; index < plan.groups.length; index += 1) {
    const group = plan.groups[index];
    const message = messages[index] ?? group.message;
    const invalid = validateMessage(message);
    if (invalid !== null) {
      lines.push(`提交中止：第 ${index + 1} 组 message 不合规——${invalid}`);
      break;
    }
    const staged = await runGit(gitBin, plan.cwd, ['diff', '--cached', '--name-only'], {
      timeoutMs,
    });
    if (staged.code !== 0) {
      lines.push(`提交中止：第 ${index + 1} 组读取暂存区失败——${staged.stderr.trim()}`);
      break;
    }
    if (staged.stdout.trim() !== '') {
      lines.push('提交中止：暂存区还有未决内容。请勾选「先取消暂存」或手动处理后再试。');
      break;
    }
    const add = await runGit(gitBin, plan.cwd, ['add', '--', ...group.files], { timeoutMs });
    if (add.code !== 0) {
      const restored = await rollback(group.files, index);
      const explained = lockHint(restored?.lock) !== '';
      lines.push(
        `提交中止：第 ${index + 1} 组暂存失败——${add.stderr.trim()}${explained ? '' : lockHint(add.lock)}`,
      );
      break;
    }
    const diff = await runGit(gitBin, plan.cwd, ['diff', '--cached', '--quiet'], { timeoutMs });
    if (diff.code === 0) {
      lines.push(`↷ 第 ${index + 1} 组没有实际改动，已跳过：${group.message}`);
      continue;
    }
    if (diff.code !== 1) {
      await rollback(group.files, index);
      lines.push(`提交中止：第 ${index + 1} 组读取暂存区失败——${diff.stderr.trim()}`);
      break;
    }

    let directory: string | undefined;
    let failure: string | undefined;
    let lock: LockReport | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'dsh-smart-commit-'));
      const file = join(directory, 'message.txt');
      await writeFile(file, message, 'utf8');
      const commit = await runGit(gitBin, plan.cwd, ['commit', '-F', file], { timeoutMs });
      if (commit.code !== 0) {
        failure = (commit.stderr || commit.stdout).trim();
        lock = commit.lock;
      } else {
        const short = await runGit(gitBin, plan.cwd, ['log', '-1', '--format=%h %s'], {
          timeoutMs,
        });
        const subject = short.stdout.trim();
        done.push(subject);
        lines.push(`OK ${index + 1}. ${subject}`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (failure !== undefined) {
      // Never leave this run's staging behind: the next click must start clean.
      const restored = await rollback(group.files, index);
      const explained = lockHint(restored?.lock) !== '';
      lines.push(
        `提交中止：第 ${index + 1} 组提交失败——${failure}${explained ? '' : lockHint(lock)}`,
      );
      break;
    }
  }

  const left = await runGit(
    gitBin,
    plan.cwd,
    ['-c', 'core.quotepath=false', 'status', '--porcelain'],
    { timeoutMs },
  );
  if (left.code !== 0) {
    lines.push(`读取剩余改动失败——${left.stderr.trim()}${lockHint(left.lock)}`);
  }
  const remaining = left.stdout.split('\n').filter((line) => line.trim() !== '');
  return finishOutcome(done, plan.groups.length, remaining, lines);
}

/**
 * Commit an SVN plan: each group is one revision over explicit paths.
 * @param plan - the plan to execute.
 * @param messages - one validated message per group.
 * @param options - svn binary and timeout.
 * @returns the outcome text and whether every group committed.
 */
async function commitSvnPlan(
  plan: Plan,
  messages: readonly string[],
  { svnBin, timeoutMs }: Pick<CommitOptions, 'svnBin' | 'timeoutMs'>,
): Promise<CommitOutcome> {
  const bin = svnBin === '' ? resolveSvn('') : svnBin;
  const done: string[] = [];
  const lines: string[] = [];
  for (let index = 0; index < plan.groups.length; index += 1) {
    const group = plan.groups[index];
    const message = messages[index] ?? group.message;
    const invalid = validateMessage(message);
    if (invalid !== null) {
      lines.push(`提交中止：第 ${index + 1} 组 message 不合规——${invalid}`);
      break;
    }
    const result = await svnCommitGroup(
      bin,
      plan.cwd,
      group.files,
      message,
      plan.untracked ?? [],
      timeoutMs,
    );
    if (!result.ok) {
      lines.push(`提交中止：第 ${index + 1} 组提交失败——${result.error}`);
      if (result.undo === null) {
        lines.push('已撤销本次 svn add，文件内容仍保留在工作区。');
      } else if (typeof result.undo === 'string') {
        lines.push(`⚠ 撤销本次 svn add 未完全成功，请手动检查：${result.undo}`);
      }
      break;
    }
    const subject = `r${result.revision} ${result.header}`;
    done.push(subject);
    lines.push(`OK ${index + 1}. ${subject}`);
  }
  const remaining = await svnRemaining(bin, plan.cwd, timeoutMs);
  return finishOutcome(done, plan.groups.length, remaining, lines);
}

/**
 * Shared closing lines for both commit adapters.
 * @param done - subjects (or revisions) that committed.
 * @param total - how many groups the plan had.
 * @param remaining - uncommitted items, already formatted.
 * @param lines - the running output.
 * @returns `{ ok, text }`.
 */
function finishOutcome(
  done: readonly string[],
  total: number,
  remaining: readonly string[],
  lines: string[],
): CommitOutcome {
  const completed = done.length === total;
  if (completed) {
    lines.push(`提交完成：${done.length} 组。`);
    if (remaining.length > 0) {
      lines.push(`未提交 ${remaining.length} 项（敏感文件或未归组）：`);
      lines.push(...remaining.slice(0, 20));
    }
  } else {
    if (done.length > 0) lines.push(`已提交 ${done.length} 组。`);
    if (remaining.length > 0) {
      lines.push(`仍有 ${remaining.length} 项未提交：`);
      lines.push(...remaining.slice(0, 20));
    }
  }
  return { ok: completed, text: lines.join('\n') };
}
