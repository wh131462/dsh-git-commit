/**
 * Path classification, grouping, and Angular commit-message rules.
 *
 * Everything in this module is pure: it takes paths, status codes, and plans,
 * and returns data. No process, filesystem, model, or HTTP access lives here,
 * which is what lets the rules be unit-tested without a repository.
 */

import { type CommitType, isCommitType, type StatusEntry } from '../shared/contract.js';
import type { CommitGroup, Plan, PlanUnit } from './dsh.js';

export const HEADER_LIMIT = 72;
export const SUBJECT_LIMIT = 50;

/**
 * Subjects that report only a file count or a bare scope, in Chinese or in
 * English. They say nothing about what changed, so they are rejected like any
 * other rule violation.
 */
const COUNT_SUBJECT_RE =
  /^(?:(?:新增|添加|调整|更新|修改|变更|改动|删除|移除|补充|完善|整理|重构)\s*了?\s*)?\d+\s*个?\s*(?:文件|文档|测试文件|测试用例|测试|配置|脚本|目录|模块|资源)|^(?:(?:add|added|adjust|adjusted|change|changed|delete|deleted|modify|modified|remove|removed|update|updated)\s+)?\d+\s+(?:files?|docs?|documents?|tests?|configs?|scripts?)\b/iu;
const EMPTY_SUBJECT_RE =
  /^(?:更新|修改|调整|变更|改动|补充|完善|新增|删除|移除|整理|重构)\s*了?\s*(?:文件|文档|测试|配置|代码|内容|相关文件)?$|^(?:update|updated|modify|modified|adjust|adjusted|add|added|fix|fixed)\s+(?:files?|docs?|code|config|tests?)?$/iu;

/** Types whose meaning is decided by the path, never by the model. */
export const OBJECTIVE_TYPES: ReadonlySet<CommitType> = new Set(['build', 'ci', 'docs', 'test']);

/** Paths the skill refuses to commit, `.env.example` style files excepted. */
const SENSITIVE = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
];
const SENSITIVE_ALLOWED = /(^|\/)\.env\.(example|sample|template)$/i;

const CI_RE =
  /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml$|\.circleci\/|Jenkinsfile$|azure-pipelines|\.travis\.ya?ml$|\.drone\.ya?ml$)/i;
const DOC_RE = /\.(md|mdx|rst|adoc|txt)$/i;
const DOC_DIR_RE = /(^|\/)(docs?|documentation)\//i;
const TEST_RE =
  /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|Test\.(java|kt)$/i;
const BUILD_RE =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|pnpm-workspace\.yaml|tsconfig[^/]*\.json|[a-z0-9._-]+\.config\.(js|mjs|cjs|ts|cts|mts)|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Makefile|\.npmrc|\.nvmrc|\.editorconfig|\.prettierrc[^/]*|\.prettierignore|\.eslintrc[^/]*|eslint\.config\.(js|mjs|cjs)|pyproject\.toml|requirements[^/]*\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle[^/]*|settings\.gradle[^/]*|\.gitignore|\.dockerignore)$/i;

/** Verb an Angular type implies when the rules have to name a group. */
const TYPE_VERBS: Record<CommitType, string> = {
  build: '更新',
  ci: '调整',
  docs: '更新',
  feat: '新增',
  fix: '修复',
  perf: '优化',
  refactor: '整理',
  revert: '回滚',
  style: '调整',
  test: '调整',
};

/**
 * Parse `git status --porcelain -z` output.
 * @param raw - the NUL-separated status text.
 * @returns entries with the two status characters, path, and rename source.
 */
export function parseStatus(raw: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === '\0') {
      index += 1;
      continue;
    }
    const code = raw.slice(index, index + 2);
    if (code.length < 2) break;
    index += 3; // "XY "
    let end = raw.indexOf('\0', index);
    if (end < 0) end = raw.length;
    const path = raw.slice(index, end);
    index = end + 1;
    let original: string | undefined;
    if (/[RC]/.test(code[0]) || /[RC]/.test(code[1])) {
      let next = raw.indexOf('\0', index);
      if (next < 0) next = raw.length;
      original = raw.slice(index, next);
      index = next + 1;
    }
    if (path !== '') entries.push({ code, path, original });
  }
  return entries;
}

/**
 * Whether the skill forbids committing this path.
 * @param path - repository-relative path.
 * @returns true for credentials and key material.
 */
export function isSensitive(path: string): boolean {
  if (SENSITIVE_ALLOWED.test(path)) return false;
  return SENSITIVE.some((pattern) => pattern.test(path));
}

/**
 * Pick the Angular type for one changed path.
 * @param path - repository-relative path.
 * @param code - the two status characters.
 * @returns a type from the Angular enum.
 */
export function classify(path: string, code: string): CommitType {
  if (CI_RE.test(path)) return 'ci';
  if (DOC_RE.test(path) || DOC_DIR_RE.test(path)) return 'docs';
  if (TEST_RE.test(path)) return 'test';
  if (BUILD_RE.test(path)) return 'build';
  return /^(A|\?\?)/.test(code) ? 'feat' : 'refactor';
}

/**
 * Derive a lowercase, hyphenated scope from a path.
 * @param path - repository-relative path.
 * @returns the scope, or `''` for repository-root files.
 */
export function scopeOf(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '';
  let scope = parts[0];
  if (
    ['apps', 'packages', 'backend', 'services', 'libs', 'modules', 'crates', 'src'].includes(
      scope.toLowerCase(),
    ) &&
    parts.length > 2
  ) {
    scope = `${scope}-${parts[1]}`;
  }
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}

/**
 * File names short enough to appear in a subject, disambiguated when two
 * paths share a basename.
 * @param files - repository-relative paths.
 * @returns one display name per path, in the same order.
 */
function shortNames(files: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const base = file.split('/').pop() ?? file;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return files.map((file) => {
    const parts = file.split('/').filter((part) => part !== '');
    const base = parts[parts.length - 1] ?? file;
    return (counts.get(base) ?? 0) === 1 ? base : parts.slice(-2).join('/');
  });
}

/**
 * The areas a group covers, used when no complete file list fits the subject.
 * @param files - repository-relative paths.
 * @returns a label such as `src/api/` or `apps/、packages/`.
 */
function areasOf(files: readonly string[]): string {
  const dirs = new Set(
    files.map((file) => {
      const cut = file.lastIndexOf('/');
      return cut < 0 ? '' : file.slice(0, cut);
    }),
  );
  if (dirs.size === 1) {
    const [only] = [...dirs];
    return only === '' ? '仓库根目录' : `${only}/`;
  }
  const tops = new Set(
    [...dirs].map((dir) => (dir === '' ? '仓库根目录' : `${dir.split('/')[0]}/`)),
  );
  return [...tops].sort().join('、');
}

/**
 * A rule-derived subject that names what the group touches.
 *
 * Every path is either named in full or replaced by the area that contains
 * it, so the subject never degenerates into "5 个文件" or a partial list that
 * silently drops the rest. The model replaces this with a semantic summary
 * whenever it is available; this text is the dialog preview and last resort.
 *
 * @param type - the Angular type.
 * @param files - the group's paths.
 * @returns a subject within `SUBJECT_LIMIT`.
 */
export function subjectFor(type: CommitType, files: readonly string[]): string {
  const verb = TYPE_VERBS[type];
  if (!Array.isArray(files) || files.length === 0) return `${verb} 相关改动`;
  const budget = SUBJECT_LIMIT - verb.length - 1;
  let joined = '';
  for (const name of shortNames(files)) {
    const next = joined === '' ? name : `${joined}、${name}`;
    if (next.length > budget) {
      joined = '';
      break;
    }
    joined = next;
  }
  if (joined !== '') return `${verb} ${joined}`;
  const area = areasOf(files);
  return `${verb} ${area.length <= budget ? area : '多处目录'}`;
}

/**
 * Build the header, shortened to the limit when the scope is long.
 * @param type - the Angular type.
 * @param scope - the optional scope.
 * @param subject - the proposed subject.
 * @returns a header within 72 characters.
 */
export function buildHeader(type: CommitType, scope: string, subject: string): string {
  const prefix = scope === '' ? `${type}: ` : `${type}(${scope}): `;
  let body = subject.trim();
  if (prefix.length + body.length > HEADER_LIMIT) {
    body = body
      .slice(0, Math.max(1, HEADER_LIMIT - prefix.length))
      .replace(/[.。,，!！?？;；:：\s]+$/u, '');
  }
  return `${prefix}${body}`;
}

/**
 * Validate one complete commit message against the Angular rules.
 * @param message - the whole message, header first.
 * @returns a failure description, or `null` when valid.
 */
export function validateMessage(message: unknown): string | null {
  if (typeof message !== 'string' || message.trim() === '') return 'message 为空';
  const lines = message.split('\n');
  const header = lines[0];
  if (header.length > HEADER_LIMIT) return `header 超过 ${HEADER_LIMIT} 字符`;
  const match = /^([a-z]+)(?:\(([a-z0-9][a-z0-9._/-]*)\))?(!)?: (.+)$/u.exec(header);
  if (match === null) return 'header 不符合 <type>(<scope>): <subject>';
  const [, type, , bang, subject] = match;
  if (!isCommitType(type)) return `type 不在枚举内：${type}`;
  if (subject.trim() === '') return 'subject 为空';
  if (/[.。,，!！?？;；:：]$/u.test(subject)) return 'subject 结尾不要标点';
  if (subject.includes('!')) return 'subject 内不要出现感叹号';
  if (/^[A-Z]/.test(subject)) return 'subject 首字母不要大写';
  if (COUNT_SUBJECT_RE.test(subject) || EMPTY_SUBJECT_RE.test(subject)) {
    return 'subject 只报了数量或范围，没有写出这组具体改了什么';
  }
  if (subject.length > SUBJECT_LIMIT) return `subject 超过 ${SUBJECT_LIMIT} 字符`;
  if (bang === '!' && !/^BREAKING CHANGE: /m.test(message)) {
    return 'header 用 ! 标记破坏性变更时，body 需写 BREAKING CHANGE: 说明';
  }
  if (lines.length > 1 && lines[1] !== '') return 'header 与 body 之间必须空一行';
  for (const line of lines.slice(1)) {
    if (line.length > 100) return 'body 行超过 100 字符';
  }
  return null;
}

/**
 * Group collected entries into type+scope units.
 * There is no group ceiling: every unit stays its own group, types are never
 * mixed, and no path is ever dropped.
 * @param entries - classified entries.
 * @returns `{ groups, skipped }` where skipped are sensitive paths.
 */
export function groupEntries(entries: readonly StatusEntry[]): {
  groups: CommitGroup[];
  skipped: string[];
} {
  const skipped: string[] = [];
  const buckets = new Map<string, CommitGroup>();
  for (const entry of entries) {
    if (isSensitive(entry.path)) {
      skipped.push(entry.path);
      continue;
    }
    const type = classify(entry.path, entry.code);
    const rawScope = scopeOf(entry.path);
    // A scope that repeats the type ("docs/docs") carries no extra meaning.
    const scope = rawScope === type ? '' : rawScope;
    const key = `${type}\u0000${scope}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { type, scope, files: [], message: '' };
      buckets.set(key, bucket);
    }
    bucket.files.push(entry.path);
  }
  const groups = [...buckets.values()];

  for (const group of groups) {
    group.files.sort();
    group.message = buildHeader(group.type, group.scope, subjectFor(group.type, group.files));
    if (validateMessage(group.message) !== null) {
      group.message = heuristicHeader(group.type, group.scope, group.files);
    }
    if (validateMessage(group.message) !== null) {
      group.message = buildHeader(group.type, '', `${TYPE_VERBS[group.type]}相关改动`);
    }
  }
  groups.sort((left, right) => left.message.localeCompare(right.message));
  return { groups, skipped };
}

/**
 * Every path the plan would commit, deduplicated and sorted. This order is
 * also the numbering the model sees, so the two must never diverge.
 * @param plan - a plan whose groups cover the changed files.
 * @returns sorted repository-relative paths.
 */
export function planFiles(plan: Plan): string[] {
  const seen = new Set<string>();
  for (const group of plan.groups) {
    for (const file of group.files) {
      if (typeof file === 'string' && file !== '') seen.add(file);
    }
  }
  return [...seen].sort();
}

/** Status codes by path, so classification matches the analysis exactly. */
export function entryCodes(plan: Plan): Map<string, string> {
  return new Map((plan.entries ?? []).map((entry) => [entry.path, entry.code]));
}

/** Lowercase, hyphenated scope; anything unrepresentable becomes `''`. */
export function cleanScope(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^[._/-]+|[._/-]+$/g, '');
}

/** A rule-derived header for a group, always valid for the Angular rules. */
export function heuristicHeader(type: CommitType, scope: string, files: readonly string[]): string {
  const header = buildHeader(type, scope, subjectFor(type, files));
  if (validateMessage(header) === null) return header;
  // A long scope can crowd the subject out of the header limit: retry free of
  // it, then fall back to a scope-free sentence that is still valid.
  const unscoped = buildHeader(type, '', subjectFor(type, files));
  if (validateMessage(unscoped) === null) return unscoped;
  return buildHeader(type, '', `${TYPE_VERBS[type]}相关改动`);
}

/**
 * The rule buckets the unit plan numbers: one type+scope unit per entry.
 * A unit cannot be split by the model; it can only be merged with other units.
 *
 * @param plan - the analyzed plan.
 * @returns `[{ type, scope, files }]`.
 */
export function planUnits(plan: Plan): PlanUnit[] {
  const fromEntries =
    Array.isArray(plan.entries) && plan.entries.length > 0
      ? groupEntries(plan.entries).groups
      : plan.groups;
  return fromEntries.map((group) => ({
    type: group.type,
    scope: group.scope,
    files: [...group.files].sort(),
  }));
}

/**
 * Repair the cheap, meaning-preserving mistakes before rejecting a header:
 * casing, spacing, and trailing punctuation.
 * @param message - the raw model header.
 * @returns a normalized header, or `''` for an empty candidate.
 */
export function normalizeMessage(message: unknown): string {
  let text = String(message ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (text === '') return '';
  text = text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/u, '')
    .trim();
  const match = /^([A-Za-z]+)\s*(?:\(([^)]*)\))?\s*(!)?\s*:\s*(.*)$/u.exec(text);
  if (match === null) return text;
  const [, rawType, rawScope, bang, rawSubject] = match;
  const type = rawType.toLowerCase();
  const scope = (rawScope ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^[._/-]+|[._/-]+$/g, '');
  const subject = rawSubject.trim().replace(/[.。,，!！?？;；:：\s]+$/u, '');
  if (subject === '') return text;
  return `${type}${scope === '' ? '' : `(${scope})`}${bang === '!' ? '!' : ''}: ${subject}`;
}
