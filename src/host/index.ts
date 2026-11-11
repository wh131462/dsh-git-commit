/**
 * Smart commit — Host half.
 *
 * The Host exposes one authenticated JSON channel under `/dsh-git-commit` on
 * the composition's web server. The Client calls `analyze`, `name`, and
 * `commit` directly; nothing goes through the command pipeline, so no command
 * node is written to the Session and no structured plan has to travel as text.
 *
 *   - `analyze` is fast: VCS status plus a rule-based preview grouping.
 *   - `name` is the one slow model call; it decides how many commits the
 *     change set should become, which files belong to each, and writes one
 *     message per commit.
 *   - `commit` re-reads the working tree, requires the confirmed groups to
 *     cover exactly the changed paths, validates every message, then commits
 *     group by group.
 */

import { API_PREFIX } from '../shared/contract.js';
import { createApi, createRouteHandler } from './api.js';
import { resolveConfig } from './config.js';
import type { PluginContext } from './dsh.js';

export const name = '@eternalheart/dsh-git-commit';
export const inject: string[] = [];

/**
 * Host entry point.
 * @param ctx - plugin context.
 * @param rawConfig - the Loader row's `config`.
 */
export function apply(ctx: PluginContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig);
  const api = createApi(ctx, config);
  const route = createRouteHandler(ctx, api);
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: route,
        }),
      'dsh-git-commit: authenticated JSON channel',
    );
  });
}
