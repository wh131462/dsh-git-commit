/**
 * The Client's typed JSON channel.
 *
 * Every call returns the `value` of a successful envelope or throws a
 * `ClientApiError` carrying the Host's stable code, so the dialog can decide
 * between a toast, a stale-plan warning, and a per-group message error.
 */

import type { Envelope } from '../shared/contract.js';

const API = 'dsh-git-commit';

/** One Host failure with the code and details the API sent back. */
export class ClientApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ClientApiError';
    this.code = code;
    this.details = details;
  }
}

/** AbortSignal.any with a fallback for older page runtimes. */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function endpointUrl(endpoint: string): string {
  // The channel lives at the server root, independent of the SPA route.
  const origin =
    typeof location === 'undefined' || typeof location.origin !== 'string'
      ? 'http://localhost'
      : location.origin;
  return `${origin}/${API}/${endpoint}`;
}

/**
 * POST one JSON request to the Host channel and unwrap its envelope.
 * @param endpoint - `analyze`, `name`, or `commit`.
 * @param payload - JSON request body.
 * @param options - dialog signal and deadline.
 * @returns the `value` of a successful envelope.
 */
export async function call<T>(
  endpoint: string,
  payload: unknown,
  { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const timeout = new AbortController();
  const limit = timeoutMs ?? 60000;
  const timer = setTimeout(() => timeout.abort(new Error('timeout')), limit);
  const composite = anySignal([signal, timeout.signal]);
  try {
    let response: Response;
    try {
      response = await fetch(endpointUrl(endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: composite,
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timeout.signal.aborted) {
        throw new ClientApiError('timeout', `请求超时（${Math.round(limit / 1000)} 秒）。`);
      }
      throw new ClientApiError('network', '连不上 DSH 的本地服务，确认应用仍在运行。');
    }
    // 404/405 means no route is registered: an older Host still serves the
    // SPA fallback here. Say how to fix it instead of reporting a raw HTTP code.
    if (response.status === 404 || response.status === 405) {
      throw new ClientApiError('no-host', 'Host 端没有加载新版插件，重启 DSH 后再试。');
    }
    if (!response.ok) {
      throw new ClientApiError('http', `插件请求失败（HTTP ${response.status}）。`);
    }
    // An older Host (or the SPA fallback) answers with HTML; say what to do
    // instead of reporting a JSON parse failure.
    if (!String(response.headers.get('content-type') ?? '').includes('application/json')) {
      throw new ClientApiError('no-host', 'Host 端没有加载新版插件，重启 DSH 后再试。');
    }
    let body: Envelope<T> | null;
    try {
      body = (await response.json()) as Envelope<T> | null;
    } catch {
      throw new ClientApiError('bad-response', '插件返回的不是 JSON。');
    }
    if (body === null || typeof body !== 'object' || body.ok !== true) {
      const failure = body !== null && typeof body === 'object' ? body.error : undefined;
      throw new ClientApiError(
        failure?.code ?? 'failed',
        failure?.message ?? '插件返回了未知错误。',
        failure?.details,
      );
    }
    return body.value;
  } finally {
    clearTimeout(timer);
  }
}
