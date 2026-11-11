/**
 * Configuration parsing for the Loader row.
 *
 * The Loader hands over whatever YAML produced, so every field is narrowed
 * here once and the rest of the Host reads a complete, clamped object.
 */

import { existsSync } from 'node:fs';

import type { CommitConfig } from './dsh.js';

/** Defaults for every configuration key the patch exposes. */
export const DEFAULTS: CommitConfig = Object.freeze({
  gitPath: '',
  svnPath: '',
  vcs: 'auto',
  timeoutMs: 20000,
  useModel: true,
  modelTimeoutMs: 60000,
  maxInputChars: 32000,
  maxTokens: 2000,
  repairRounds: 1,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Fold the Loader row's config over this plugin's defaults.
 * @param raw - the row's `config` value.
 * @returns a complete configuration.
 */
export function resolveConfig(raw: unknown): CommitConfig {
  const source = isRecord(raw) ? raw : {};
  const vcs =
    source.vcs === 'auto' || source.vcs === 'git' || source.vcs === 'svn'
      ? source.vcs
      : DEFAULTS.vcs;
  return {
    gitPath: nonEmptyString(source.gitPath, DEFAULTS.gitPath),
    svnPath: nonEmptyString(source.svnPath, DEFAULTS.svnPath),
    vcs,
    timeoutMs: positive(source.timeoutMs, DEFAULTS.timeoutMs),
    useModel: source.useModel !== false,
    modelTimeoutMs: positive(source.modelTimeoutMs, DEFAULTS.modelTimeoutMs),
    maxInputChars: Math.max(
      1000,
      Math.round(positive(source.maxInputChars, DEFAULTS.maxInputChars)),
    ),
    maxTokens: Math.max(64, Math.round(positive(source.maxTokens, DEFAULTS.maxTokens))),
    repairRounds: Math.min(
      3,
      Math.max(0, Math.round(positive(source.repairRounds, DEFAULTS.repairRounds))),
    ),
  };
}

/**
 * Locate a git binary that works even under a Finder-launched PATH.
 * @param configured - an explicit `gitPath`, or `''`.
 * @returns the executable to spawn.
 */
export function resolveGit(configured: string): string {
  const candidates = [
    configured,
    process.env.GIT_PATH,
    '/usr/bin/git',
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  for (const candidate of candidates) {
    if (candidate === 'git' || existsSync(candidate)) return candidate;
  }
  return 'git';
}
