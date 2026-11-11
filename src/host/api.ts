/**
 * The authenticated JSON channel and its HTTP adapter.
 *
 * `createApi` is pure Host logic and never touches HTTP; `createRouteHandler`
 * owns authentication, JSON validation, and envelope serialization. The
 * Client only ever sends a Session id, and the Host resolves the directory, so
 * a request cannot point a commit at a directory the Session does not own.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type AnalyzeResult,
  API_PREFIX,
  API_VERSION,
  type CommitRequest,
  type CommitResult,
  type EmptyResult,
  type GroupFailure,
  isCommitType,
  type NameResult,
  type PingResult,
  type WirePlan,
} from '../shared/contract.js';
import { commitPlan } from './commit.js';
import { resolveGit } from './config.js';
import type { CommitConfig, CommitGroup, Plan, PluginContext, SessionLike } from './dsh.js';
import { ApiError } from './errors.js';
import { currentRoute, namePlan } from './model.js';
import { classify, cleanScope, entryCodes, planFiles, validateMessage } from './plan.js';
import { lockHint, runGit } from './process.js';
import { analyzeRepo } from './repo.js';
import { resolveSvn } from './svn.js';

/** Requests carry at most a plan, its paths, and the edited messages. */
const BODY_LIMIT = 2 * 1024 * 1024;

/** The public surface `createApi` exposes to the route. */
export interface SmartCommitApi {
  ping(): PingResult;
  analyze(payload: unknown): Promise<AnalyzeResult | EmptyResult>;
  name(payload: unknown, options?: { signal?: AbortSignal }): Promise<NameResult | EmptyResult>;
  commit(payload: unknown): Promise<CommitResult>;
}

type ApiHandler = (payload: unknown, options: { signal?: AbortSignal }) => Promise<unknown>;

interface Target {
  session: SessionLike;
  cwd: string;
}

/**
 * Resolve a Session's working directory.
 * @param ctx - plugin context.
 * @param session - the Session served by this call.
 * @returns an absolute path.
 */
function sessionCwd(ctx: PluginContext, session: SessionLike | undefined): string {
  const directory = ctx.get('workingDirectory');
  if (directory !== undefined && session !== undefined) {
    try {
      const value = directory.get(session);
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      /* fall through to the session header */
    }
  }
  const fromHeader = session?.header?.cwd;
  return typeof fromHeader === 'string' && fromHeader !== '' ? fromHeader : process.cwd();
}

/**
 * Resolve the Session named by a request.
 *
 * The Client only sends an id; the Host resolves the directory, so a request
 * can never point the commit at a directory the Session does not own.
 *
 * @param ctx - plugin context.
 * @param sessionId - the id the Client named.
 * @returns `{ session, cwd }`.
 */
function resolveTarget(ctx: PluginContext, sessionId: unknown): Target {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new ApiError('no-session', '没有可用的会话。');
  }
  const sessions = ctx.get('sessions');
  const session = sessions?.get?.(sessionId);
  if (session === undefined || session === null) {
    throw new ApiError('no-session', '会话不存在或已关闭，重新打开会话后再试。');
  }
  return { session, cwd: sessionCwd(ctx, session) };
}

/**
 * The wire form of a plan: no cwd, no timestamps, no host-only fields.
 * @param plan - the analyzed plan.
 * @returns the JSON-safe plan the Client edits.
 */
export function publicPlan(plan: Plan): WirePlan {
  return {
    vcs: plan.vcs,
    branch: plan.branch,
    hasHead: plan.hasHead === true,
    ...(plan.revision === undefined ? {} : { revision: plan.revision }),
    staged: [...(plan.staged ?? [])],
    groups: plan.groups.map((group) => ({
      type: group.type,
      scope: group.scope,
      message: typeof group.message === 'string' ? group.message : '',
      suggestion: typeof group.suggestion === 'string' ? group.suggestion : '',
      files: [...group.files],
    })),
    skipped: [...(plan.skipped ?? [])],
    warnings: [...(plan.warnings ?? [])],
    untracked: [...(plan.untracked ?? [])],
    added: [...(plan.added ?? [])],
  };
}

/**
 * Validate the grouping the user confirmed against the tree as it is now.
 *
 * The model chose the grouping, so the Host cannot re-derive it; what it can
 * prove is coverage: every changed path appears exactly once, no path that is
 * no longer changed is included, and no group is empty. Messages may differ
 * from the preview because that is what the dialog edits.
 *
 * @param submitted - the plan sent back by the Client.
 * @param fresh - a plan just rebuilt from the working tree.
 * @returns the confirmed groups, normalized, ready to commit.
 * @throws `ApiError('stale')` when the two describe different changes.
 */
export function planFromSubmitted(submitted: unknown, fresh: Plan): CommitGroup[] {
  const stale = (): never => {
    throw new ApiError('stale', '工作区在确认期间发生了变化，请重新分析后再提交。');
  };
  const value = (submitted ?? {}) as { vcs?: unknown; groups?: unknown };
  const groups = Array.isArray(value.groups) ? value.groups : null;
  if (value.vcs !== fresh.vcs || groups === null || groups.length === 0) throw stale();

  const freshFiles = planFiles(fresh);
  const allowed = new Set(freshFiles);
  const codes = entryCodes(fresh);
  const seen = new Set<string>();
  const normalized: CommitGroup[] = [];
  for (const group of groups) {
    const item = (group ?? {}) as {
      files?: unknown;
      type?: unknown;
      scope?: unknown;
      message?: unknown;
    };
    const files = Array.isArray(item.files) ? item.files : null;
    if (files === null || files.length === 0) throw stale();
    const picked: string[] = [];
    for (const file of files) {
      if (typeof file !== 'string' || !allowed.has(file) || seen.has(file)) throw stale();
      seen.add(file);
      picked.push(file);
    }
    picked.sort();
    const declaredType = typeof item.type === 'string' ? item.type : '';
    normalized.push({
      type: isCommitType(declaredType)
        ? declaredType
        : classify(picked[0], codes.get(picked[0]) ?? ''),
      scope: cleanScope(item.scope),
      files: picked,
      message: typeof item.message === 'string' ? item.message : '',
    });
  }
  // A path the dialog never showed must not be left out of the commit.
  if (seen.size !== allowed.size) throw stale();
  return normalized;
}

/**
 * Compare the plan the user confirmed with the tree as it is now.
 * @param submitted - the plan sent back by the Client.
 * @param fresh - a plan just rebuilt from the working tree.
 * @throws `ApiError('stale')` when the two describe different changes.
 */
export function assertPlanMatches(submitted: unknown, fresh: Plan): void {
  planFromSubmitted(submitted, fresh);
}

/**
 * Build the API the HTTP channel exposes. Pure Host logic: no HTTP concerns.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @returns `{ analyze, name, commit, ping }`.
 */
export function createApi(ctx: PluginContext, config: CommitConfig): SmartCommitApi {
  const gitBin = resolveGit(config.gitPath);
  const svnBin = resolveSvn(config.svnPath);
  const binaries = { gitBin, svnBin };

  /** Rebuild the plan from the tree; a failure becomes a business error. */
  async function analyzePlan(target: Target): Promise<Plan> {
    const analysis = await analyzeRepo({
      ...binaries,
      vcs: config.vcs,
      cwd: target.cwd,
      timeoutMs: config.timeoutMs,
    });
    if (!analysis.ok) {
      const code =
        analysis.sensitive === true
          ? 'sensitive'
          : analysis.clean === true
            ? 'clean'
            : analysis.notRepo === true
              ? 'not-a-repo'
              : 'analyze-failed';
      throw new ApiError(code, analysis.text);
    }
    return analysis.plan;
  }

  /**
   * Nothing to commit is a normal answer, not an error: hand the Client an
   * empty result so it can close the dialog and say so once.
   * @param error - the `clean` / `sensitive` business error.
   * @returns the success payload for an empty working tree.
   */
  function emptyResult(error: ApiError): EmptyResult {
    return {
      api: API_VERSION,
      empty: true,
      reason: error.code,
      message: error.message,
    };
  }

  /** The model route this Session uses, when naming is on. */
  function routeFor(target: Target) {
    return config.useModel ? currentRoute(ctx, target.session) : undefined;
  }

  /**
   * Fast step: status, grouping, and the model route, with every editable
   * message still empty.
   */
  async function analyze(payload: unknown): Promise<AnalyzeResult | EmptyResult> {
    const request = (payload ?? {}) as { sessionId?: unknown };
    const target = resolveTarget(ctx, request.sessionId);
    let plan: Plan;
    try {
      plan = await analyzePlan(target);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'clean' || error.code === 'sensitive')) {
        return emptyResult(error);
      }
      throw error;
    }
    for (const group of plan.groups) {
      group.suggestion = group.message;
      group.message = '';
    }
    const route = routeFor(target);
    return {
      api: API_VERSION,
      plan: publicPlan(plan),
      useModel: config.useModel,
      model: route === undefined ? null : `${route.provider}/${route.model}`,
    };
  }

  /**
   * Slow step: one model call plans the commits and names each of them. The
   * plan is rebuilt here, so a Client cannot smuggle paths into the prompt.
   */
  async function nameMessages(
    payload: unknown,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<NameResult | EmptyResult> {
    const request = (payload ?? {}) as { sessionId?: unknown };
    const target = resolveTarget(ctx, request.sessionId);
    let plan: Plan;
    try {
      plan = await analyzePlan(target);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'clean' || error.code === 'sensitive')) {
        return emptyResult(error);
      }
      throw error;
    }
    const route = routeFor(target);
    const named = await namePlan(ctx, config, plan, {
      signal,
      sessionId: typeof request.sessionId === 'string' ? request.sessionId : undefined,
      route,
      gitBin,
      svnBin,
    });
    return {
      plan: publicPlan(named.plan),
      messages: named.messages,
      note: named.note,
      failures: named.failures,
      model: route === undefined ? null : `${route.provider}/${route.model}`,
    };
  }

  /**
   * Commit the confirmed plan. The tree is re-read first; the confirmed groups
   * must still cover exactly the changed paths, so a message can never be
   * committed against files it was not written for.
   */
  async function commit(payload: unknown): Promise<CommitResult> {
    const request = (payload ?? {}) as Partial<CommitRequest> & {
      sessionId?: unknown;
      plan?: unknown;
      messages?: unknown;
      unstage?: unknown;
    };
    const target = resolveTarget(ctx, request.sessionId);
    let fresh: Plan;
    try {
      fresh = await analyzePlan(target);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'clean' || error.code === 'sensitive')) {
        throw new ApiError(
          'stale',
          error.code === 'sensitive'
            ? error.message
            : '工作区已经没有可提交的改动（可能已在别处提交），请重新分析。',
        );
      }
      throw error;
    }
    const groups = planFromSubmitted(request.plan, fresh);

    const messages = request.messages;
    if (!Array.isArray(messages) || messages.length !== groups.length) {
      throw new ApiError('invalid-message', '提交参数与分组数量不一致，请重新分析。');
    }

    // Check every header before touching the index: one bad group must not
    // leave the earlier groups committed and the dialog half-done.
    const problems: GroupFailure[] = [];
    messages.forEach((message, index) => {
      if (typeof message !== 'string') {
        problems.push({ index, reason: 'message 不是字符串' });
        return;
      }
      const invalid = validateMessage(message);
      if (invalid !== null) problems.push({ index, reason: invalid });
    });
    if (problems.length > 0) {
      throw new ApiError('invalid-message', `${problems.length} 组 message 未通过校验。`, {
        groups: problems,
      });
    }

    // A pre-existing index would mix somebody else's staging into the first
    // commit. The dialog can ask to release exactly those paths first. SVN has
    // no index, so this branch is Git-only.
    if (fresh.vcs === 'git' && fresh.staged.length > 0) {
      if (request.unstage !== true) {
        throw new ApiError(
          'staged',
          `提交中止：暂存区已有 ${fresh.staged.length} 个文件，先勾选「先取消暂存」再提交。`,
          { paths: fresh.staged },
        );
      }
      const release = await runGit(
        gitBin,
        fresh.cwd,
        ['restore', '--staged', '--', ...fresh.staged],
        { timeoutMs: config.timeoutMs },
      );
      if (release.code !== 0) {
        const locked = release.lock?.status === 'held' || release.lock?.status === 'unknown';
        throw new ApiError(
          locked ? 'locked' : 'staged',
          `提交中止：取消暂存失败——${release.stderr.trim()}${lockHint(release.lock)}`,
        );
      }
      fresh.staged = [];
    }

    // Commit the confirmed grouping, not the rule preview: the tree check
    // above already proved it covers exactly the current changes.
    const outcome = await commitPlan({ ...fresh, groups }, messages as string[], {
      ...binaries,
      timeoutMs: config.timeoutMs,
    });
    return { ok: outcome.ok, text: outcome.text };
  }

  return {
    ping: () => ({ api: API_VERSION, vcs: config.vcs, useModel: config.useModel }),
    analyze,
    name: nameMessages,
    commit,
  };
}

/**
 * Read a JSON request body with a hard byte cap.
 * @param req - the incoming request.
 * @returns the parsed body.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new ApiError('body-too-large', '请求体过大。');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('bad-json', '请求体不是合法 JSON。');
  }
}

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Adapt the API to the `webServer` prefix route.
 *
 * The route is same-origin and authenticated by Connection: the request must
 * pass the Host/Origin fence, carry the browser session cookie, and speak for
 * the owner Peer. A request that fails any check never reaches the API.
 *
 * @param ctx - plugin context.
 * @param api - `createApi()` result.
 * @returns a `webServer` route handler.
 */
export function createRouteHandler(
  ctx: PluginContext,
  api: SmartCommitApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handlers: Record<string, ApiHandler> = {
    ping: async () => api.ping(),
    analyze: async (payload) => api.analyze(payload),
    name: async (payload, options) => api.name(payload, options),
    commit: async (payload) => api.commit(payload),
  };

  return async function route(req, res): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 POST。' } });
      return;
    }
    const connection = ctx.get('connection');
    if (connection === undefined || typeof connection.admit !== 'function') {
      sendJson(res, 503, {
        ok: false,
        error: { code: 'no-connection', message: '连接服务不可用。' },
      });
      return;
    }
    const admission = connection.admit(req);
    if ('rejection' in admission) {
      res.writeHead(admission.rejection);
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    if (admission.peer?.principal?.kind !== 'owner') {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const endpoint = pathname.slice(API_PREFIX.length + 1);
    const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined;
    if (handler === undefined) {
      sendJson(res, 404, {
        ok: false,
        error: { code: 'not-found', message: '未知的接口。' },
      });
      return;
    }
    const type = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/json') {
      sendJson(res, 415, {
        ok: false,
        error: { code: 'content-type', message: '请使用 application/json。' },
      });
      return;
    }

    // The browser may close the dialog while the model call is running; tie
    // the API signal to the response so the Host stops the model stream.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.code === 'body-too-large' ? 413 : 400, {
          ok: false,
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }

    try {
      const value = await handler(payload, { signal: controller.signal });
      sendJson(res, 200, { ok: true, value });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError) {
        sendJson(res, 200, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
        return;
      }
      try {
        ctx.logger?.warn?.(error);
      } catch {
        /* logging must not mask the failure */
      }
      sendJson(res, 200, {
        ok: false,
        error: {
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}
