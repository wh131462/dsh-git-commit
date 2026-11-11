/**
 * The Host's local view of DSH.
 *
 * DSH does not ship type declarations with the desktop app, so the plugin
 * declares exactly the service surface it uses. Keeping the facade in one file
 * means a DSH API change has one place to land, and the rest of the Host is
 * typed against ordinary interfaces instead of `any`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CommitType, StatusEntry, VcsKind } from '../shared/contract.js';

/** The Loader row's configuration after defaults and clamping. */
export interface CommitConfig {
  gitPath: string;
  svnPath: string;
  vcs: 'auto' | VcsKind;
  timeoutMs: number;
  useModel: boolean;
  modelTimeoutMs: number;
  maxInputChars: number;
  maxTokens: number;
  repairRounds: number;
}

/** One group that becomes one commit. */
export interface CommitGroup {
  type: CommitType;
  scope: string;
  files: string[];
  message: string;
  suggestion?: string;
  /** Set by the rule fallback: this group still needs a model-written message. */
  filled?: boolean;
  failure?: string;
}

/** One type+scope bucket the unit prompt numbers. */
export interface PlanUnit {
  type: CommitType;
  scope: string;
  files: string[];
}

/** The Host-side plan; `cwd`, `entries`, and `at` never reach the Client. */
export interface Plan {
  vcs: VcsKind;
  cwd: string;
  branch: string;
  hasHead: boolean;
  revision?: number;
  staged: string[];
  groups: CommitGroup[];
  entries?: StatusEntry[];
  skipped?: string[];
  warnings?: string[];
  untracked?: string[];
  added?: string[];
  at: number;
}

/** The model route a Session is already using. */
export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelSelection {
  provider?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
}

export interface SessionLike {
  header?: { cwd?: unknown };
  requestHeader?: () => { config?: ModelSelection } | undefined;
}

export interface SessionsService {
  get(sessionId: string): SessionLike | null | undefined;
}

export interface WorkingDirectoryService {
  get(session: SessionLike): unknown;
}

export interface AgentDefaultModelService {
  currentSelection?(): ModelSelection | undefined;
}

export interface ModelInfo {
  reasoning?: { efforts?: Array<{ id: string }> };
}

export interface LlmStreamOptions {
  provider: string;
  model: string;
  system: string;
  messages: Array<{
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  }>;
  maxTokens: number;
  signal?: AbortSignal;
  reasoningEffort?: string;
  sessionId?: string;
}

export interface LlmChunk {
  type: string;
  text?: string;
  reason?: {
    kind: string;
    failure?: { message?: string };
  };
}

export interface LlmService {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | undefined>;
  stream(options: LlmStreamOptions): AsyncIterable<LlmChunk>;
}

export type Admission = { rejection: number } | { peer?: { principal?: { kind?: string } } };

export interface ConnectionService {
  admit(req: IncomingMessage): Admission;
}

export interface WebServerService {
  register(options: {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): unknown;
}

/** Every service this plugin reads by name. */
export interface ServiceRegistry {
  sessions: SessionsService;
  workingDirectory: WorkingDirectoryService;
  llm: LlmService;
  agentDefaultModel: AgentDefaultModelService;
  connection: ConnectionService;
  webServer: WebServerService;
}

/**
 * The Cordis plugin context, narrowed to the surface this plugin uses.
 *
 * `get` is generic so a service is typed at the call site; the runtime object
 * is the real Cordis context, this is only the structural view.
 */
export interface PluginContext {
  inject<K extends keyof ServiceRegistry>(
    deps: readonly K[],
    fn: (ctx: PluginContext & Pick<ServiceRegistry, K>) => void,
  ): void;
  effect(fn: () => unknown, label?: string): void;
  get<K extends keyof ServiceRegistry>(name: K): ServiceRegistry[K] | undefined;
  logger?: { warn?(error: unknown): void };
}

/** The context inside `inject(['webServer', 'connection'], …)`. */
export type WebContext = PluginContext & {
  webServer: WebServerService;
  connection: ConnectionService;
};
