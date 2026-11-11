/**
 * The wire contract shared by both halves of the plugin.
 *
 * These types are the only thing the Host and the browser Client agree on.
 * They are imported with `import type` on the Client, so nothing in this file
 * reaches the bundle at runtime.
 */

/** The one HTTP prefix this plugin owns on the composition's web server. */
export const API_PREFIX = '/dsh-git-commit';

/** Inline API revision; the Client names it when it needs to explain a mismatch. */
export const API_VERSION = 5;

/** Angular type enum from @commitlint/config-angular. */
export const COMMIT_TYPES = [
  'build',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export type VcsKind = 'git' | 'svn';

export type VcsMode = 'auto' | VcsKind;

/** One changed path as the Host read it from the VCS. */
export interface StatusEntry {
  /** The two status characters, e.g. ` M`, `??`, `A `. */
  code: string;
  /** Repository-relative POSIX path. */
  path: string;
  /** The pre-rename path, when Git reported a rename or copy. */
  original?: string;
  /** SVN: the path is not under version control yet. */
  untracked?: boolean;
}

/** One group of paths that becomes one commit. */
export interface WireGroup {
  /** The Angular type, or the model's raw value before validation. */
  type: string;
  scope: string;
  message: string;
  /** Rule-derived preview, kept even after the message is edited. */
  suggestion: string;
  files: string[];
  /** Client-only: a stable identity while the user regroups. */
  id?: string;
  /** Client-only: the grouping changed after the model named it. */
  edited?: boolean;
}

/** The JSON-safe plan the Client edits. */
export interface WirePlan {
  vcs: VcsKind;
  branch: string;
  hasHead: boolean;
  revision?: number;
  staged: string[];
  groups: WireGroup[];
  skipped: string[];
  warnings: string[];
  untracked: string[];
  added: string[];
}

/** A group whose model message failed validation. */
export interface GroupFailure {
  index: number;
  reason: string;
}

/** One business failure the Client can show verbatim. */
export interface ApiFailure {
  code: string;
  message: string;
  details?: unknown;
}

export interface AnalyzeRequest {
  sessionId: string;
}

export interface NameRequest {
  sessionId: string;
}

export interface CommitRequest {
  sessionId: string;
  plan: WirePlan;
  messages: string[];
  unstage?: boolean;
}

/** `analyze` succeeded and there is something to review. */
export interface AnalyzeResult {
  api: typeof API_VERSION;
  plan: WirePlan;
  useModel: boolean;
  model: string | null;
  empty?: false;
}

/** The working tree is clean, or only sensitive files are left. */
export interface EmptyResult {
  api: typeof API_VERSION;
  empty: true;
  reason: string;
  message: string;
}

export interface NameResult {
  plan: WirePlan;
  messages: string[];
  note: string;
  failures: GroupFailure[];
  model: string | null;
  empty?: false;
}

export interface CommitResult {
  ok: boolean;
  text: string;
}

export interface PingResult {
  api: typeof API_VERSION;
  vcs: VcsMode;
  useModel: boolean;
}

/** The envelope every endpoint returns, success or business failure. */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

/** Narrow a raw string to the Angular type enum. */
export function isCommitType(value: unknown): value is CommitType {
  return typeof value === 'string' && (COMMIT_TYPES as readonly string[]).includes(value);
}
