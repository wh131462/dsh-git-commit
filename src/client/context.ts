/**
 * The Client's local view of DSH.
 *
 * The browser half is a Cordis plugin loaded through `window.__ModuleLoader__`:
 * it receives the same context object as an in-tree client package, narrowed
 * here to the locale and slot services this dialog uses.
 */

export interface LocaleSnapshot {
  id?: unknown;
  locale?: unknown;
}

export interface LocaleService {
  register(namespace: string, language: string, table: Record<string, string>): unknown;
  getLocale?(): unknown;
}

export interface SlotOptions {
  name: string;
  id: string;
  order: number;
  locale?: string;
}

export interface SlotsService {
  inject(slot: string, fn: () => void): void;
  register(options: SlotOptions, component: unknown): unknown;
}

export interface ClientContext {
  locale?: LocaleService;
  slots?: SlotsService;
  effect(fn: () => unknown, label?: string): void;
  inject(deps: readonly string[], fn: (ctx: ClientContext) => void): void;
}

/** The context inside `inject(['slots'], …)`. */
export type SlotsContext = ClientContext & { slots: SlotsService };
