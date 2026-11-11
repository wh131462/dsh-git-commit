/**
 * The Client's React surface: the input-row button and the confirmation dialog.
 *
 * The components read from the shared store and call the store's pure
 * operations; the network flow lives in `controller.ts`. React comes from the
 * Harness module table (`react` and `react/jsx-runtime` are platform
 * externals), so nothing here is bundled with a second React.
 */

import * as React from 'react';

import type { ClientContext } from './context.js';
import { commit, regenerate, restart, start } from './controller.js';
import { translator } from './i18n.js';
import type { Phase, Store } from './store.js';
import {
  closeDialog,
  emit,
  mergeUp,
  moveFiles,
  moveSelected,
  toggleExpanded,
  toggleSelected,
  toggleSelectedInGroup,
  toggleUnstage,
  updateMessage,
} from './store.js';

const NS = 'dsh-smart-commit';

const CSS = [
  // Button.
  '.dsh-sc-btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease;}',
  '.dsh-sc-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
  '.dsh-sc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
  '.dsh-sc-btn[data-state="done"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.dsh-sc-btn[data-state="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
  '.dsh-sc-btn[disabled]{cursor:progress;opacity:.7;}',
  '.dsh-sc-icon{display:inline-flex;align-items:center;}',
  // Spinner + progress.
  '.dsh-sc-spinner{width:11px;height:11px;flex:none;border:1.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dsh-sc-spin .75s linear infinite;}',
  '@keyframes dsh-sc-spin{to{transform:rotate(360deg);}}',
  '.dsh-sc-progress{display:flex;align-items:center;gap:8px;margin:2px 0 12px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;}',
  '.dsh-sc-progress-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  // Overlay + dialog.
  '.dsh-sc-backdrop{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto;background:color-mix(in srgb, var(--dsw-alias-bg-base) 58%, transparent);}',
  '.dsh-sc-dialog{position:relative;display:flex;flex-direction:column;width:min(680px,100%);max-height:min(82vh,760px);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 16px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);overflow:hidden;}',
  '.dsh-sc-head{display:flex;align-items:flex-start;gap:12px;padding:16px 20px 12px;}',
  '.dsh-sc-head-text{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;}',
  '.dsh-sc-title{font-size:14px;font-weight:600;line-height:20px;}',
  '.dsh-sc-subrow{display:flex;align-items:center;gap:10px;min-width:0;}',
  '.dsh-sc-sub{min-width:0;flex:0 1 auto;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-sc-branch{min-width:0;max-width:220px;flex:0 1 auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-sc-vcs{flex:none;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;letter-spacing:.04em;}',
  '.dsh-sc-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1;cursor:pointer;}',
  '.dsh-sc-x:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
  '.dsh-sc-x:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
  '.dsh-sc-body{flex:1;min-height:0;overflow:auto;padding:0 20px 6px;}',
  '.dsh-sc-group{display:flex;flex-direction:column;gap:6px;margin:0 -8px;padding:9px 8px;border:0;border-radius:8px;transition:background-color .12s ease;}',
  '.dsh-sc-group[data-over="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);}',
  '.dsh-sc-group-head{display:flex;align-items:flex-start;gap:8px;}',
  '.dsh-sc-idx{width:16px;flex:none;padding-top:6px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums;}',
  '.dsh-sc-tool{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-top:2px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;}',
  '.dsh-sc-tool:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
  '.dsh-sc-tool:disabled{opacity:.5;cursor:progress;}',
  '.dsh-sc-chips{display:flex;flex-wrap:wrap;gap:5px;padding-left:24px;}',
  '.dsh-sc-chip{max-width:100%;padding:1px 6px;border:0;border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:17px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dsh-sc-chip:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-primary);}',
  '.dsh-sc-chip[data-selected="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.dsh-sc-chip:disabled{cursor:progress;opacity:.7;}',
  '.dsh-sc-chip-more{background:transparent;}',
  '.dsh-sc-gsel{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:transparent;font:inherit;font-size:11px;line-height:1;cursor:pointer;}',
  '.dsh-sc-gsel:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.dsh-sc-gsel[data-checked="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay);}',
  '.dsh-sc-gsel:disabled{opacity:.5;cursor:progress;}',
  '.dsh-sc-chips[data-selecting="true"] .dsh-sc-chip:not([data-selected="true"]):not(.dsh-sc-chip-more){opacity:.6;}',
  '.dsh-sc-chips[data-selecting="true"] .dsh-sc-chip:not([data-selected="true"]):not(.dsh-sc-chip-more):hover{opacity:1;}',
  '.dsh-sc-chips[data-selecting="true"] .dsh-sc-chip:not([data-selected="true"]):not(.dsh-sc-chip-more):focus-visible{opacity:1;}',
  '.dsh-sc-tag{flex:none;padding:0 5px;border-radius:4px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-primary);}',
  '.dsh-sc-selbar{display:flex;align-items:center;gap:6px;min-width:0;margin-right:auto;}',
  '.dsh-sc-selcount{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-sc-dropdown{position:relative;flex:none;}',
  '.dsh-sc-moveto{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:22px;white-space:nowrap;cursor:pointer;}',
  '.dsh-sc-moveto:hover{background:var(--dsw-alias-bg-layer-1);}',
  '.dsh-sc-moveto:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
  '.dsh-sc-caret{width:0;height:0;border-left:3.5px solid transparent;border-right:3.5px solid transparent;border-top:4px solid currentColor;opacity:.65;}',
  '.dsh-sc-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer;}',
  '.dsh-sc-clear:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
  '.dsh-sc-clear:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
  '.dsh-sc-scrim{position:fixed;inset:0;z-index:4;background:transparent;}',
  '.dsh-sc-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:5;min-width:180px;max-height:min(220px,40vh);overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);}',
  '.dsh-sc-menu-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;height:26px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:1;text-align:left;cursor:pointer;}',
  '.dsh-sc-menu-item:hover{background:var(--dsw-alias-bg-layer-1);}',
  '.dsh-sc-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}',
  '.dsh-sc-menu-count{flex:none;color:var(--dsw-alias-label-secondary);font-size:10px;}',
  '.dsh-sc-menu-sep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1);}',
  '@media (max-width:560px){.dsh-sc-selcount{display:none;}}',
  '.dsh-sc-field{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}',
  '.dsh-sc-input{width:100%;box-sizing:border-box;min-height:28px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;resize:none;overflow:hidden;}',
  '.dsh-sc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
  '.dsh-sc-input:disabled{opacity:.72;cursor:progress;}',
  '.dsh-sc-input[data-loading="true"]{border-style:dashed;}',
  '.dsh-sc-meta{display:flex;align-items:center;gap:6px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-sc-count{flex:none;}',
  '.dsh-sc-line{margin-top:1px;font-size:11px;line-height:15px;}',
  '.dsh-sc-line[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);}',
  '.dsh-sc-line[data-kind="error"]{color:var(--dsw-alias-state-error-primary);}',
  '.dsh-sc-warn{margin:8px 0 0;padding:7px 9px;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px;}',
  '.dsh-sc-warn-paths{margin-top:4px;max-height:84px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:inherit;opacity:.9;}',
  '.dsh-sc-check{display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;}',
  '.dsh-sc-check input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:14px;height:14px;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:3px;background:var(--dsw-alias-bg-base);cursor:pointer;}',
  '.dsh-sc-check input:checked{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);}',
  '.dsh-sc-check input:checked::after{content:"";position:absolute;left:3px;top:1px;width:4px;height:7px;border:solid var(--dsw-alias-bg-overlay);border-width:0 1.5px 1.5px 0;transform:rotate(45deg);}',
  '.dsh-sc-check input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
  '.dsh-sc-check input:disabled{opacity:.6;cursor:progress;}',
  '.dsh-sc-note{margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-sc-pre{margin:6px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;}',
  '.dsh-sc-error{color:var(--dsw-alias-state-error-primary);}',
  '.dsh-sc-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);}',
  '.dsh-sc-foot-hint{margin-right:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-sc-primary,.dsh-sc-ghost{height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);font:inherit;font-size:12px;cursor:pointer;flex:none;}',
  '.dsh-sc-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}',
  '.dsh-sc-primary:disabled{opacity:.6;cursor:progress;}',
  '.dsh-sc-ghost{background:transparent;color:var(--dsw-alias-label-secondary);}',
  '.dsh-sc-ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
  '.dsh-sc-ghost:disabled{opacity:.6;cursor:progress;}',
  '.dsh-sc-primary:focus-visible,.dsh-sc-ghost:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
  '.dsh-sc-skeleton{display:flex;flex-direction:column;gap:10px;padding:8px 0 4px;}',
  '.dsh-sc-skeleton-row{height:34px;border-radius:8px;background:linear-gradient(90deg, var(--dsw-alias-bg-layer-1), color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, var(--dsw-alias-bg-base)), var(--dsw-alias-bg-layer-1));background-size:200% 100%;animation:dsh-sc-shimmer 1.4s ease-in-out infinite;}',
  '@keyframes dsh-sc-shimmer{0%{background-position:0% 0;}100%{background-position:-200% 0;}}',
  '@media (prefers-reduced-motion: reduce){.dsh-sc-spinner{animation-duration:2.4s;}.dsh-sc-skeleton-row{animation:none;}}',
].join('\n');

interface SlotProps {
  sessionId?: unknown;
  useSession?: unknown;
  t?: unknown;
}

function useStore<T>(store: Store, selector: () => T, deps: React.DependencyList): T {
  const [value, setValue] = React.useState<T>(selector);
  React.useEffect(() => {
    const listener = () => setValue(selector());
    store.listeners.add(listener);
    listener();
    return () => {
      store.listeners.delete(listener);
    };
    // The selector and store are stable; deps are the values the selector reads.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller owns the dependency list.
  }, deps);
  return value;
}

/** A commit node on the current branch, with a sparkle for the smart naming. */
function CommitIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={13} height={13} fill="none" aria-hidden="true">
      <path
        d="M6.2 1.9v2.8M6.2 11.3v2.8"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <circle cx={6.2} cy={8} r={2.55} stroke="currentColor" strokeWidth={1.7} />
      <circle cx={6.2} cy={8} r={0.95} fill="currentColor" />
      <path
        d="M12.4 1.9c.22 2.3.8 2.88 3.1 3.1-2.3.22-2.88.8-3.1 3.1-.22-2.3-.8-2.88-3.1-3.1 2.3-.22 2.88-.8 3.1-3.1Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** The busy dot next to a phase label. */
function Spinner(): React.ReactElement {
  return <span className="dsh-sc-spinner" aria-hidden="true" />;
}

/** One phase banner: spinner plus a sentence. */
function Progress({ text }: { text: string }): React.ReactElement {
  return (
    <div className="dsh-sc-progress" role="status" aria-live="polite">
      <span className="dsh-sc-spinner" aria-hidden="true" />
      <span className="dsh-sc-progress-text">{text}</span>
    </div>
  );
}

function Skeleton(): React.ReactElement {
  return (
    <div className="dsh-sc-skeleton" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="dsh-sc-skeleton-row" />
      ))}
    </div>
  );
}

/**
 * Build the input-row button.
 * @param store - the page store.
 * @param ctx - the plugin context that owns locale and slots.
 * @returns the slot component.
 */
export function createButton(store: Store, ctx: ClientContext): React.ComponentType<SlotProps> {
  // biome-ignore lint/correctness/noComponentHookFactories: one component per store.
  return function SmartCommitButton(props: SlotProps): React.ReactElement {
    const tr = translator(ctx, props);
    const hook = typeof props.useSession === 'function' ? props.useSession : undefined;
    const stored =
      hook === undefined
        ? undefined
        : (
            hook as (
              selector: (snapshot: { sessionId?: unknown } | undefined) => unknown,
            ) => unknown
          )((snapshot) => snapshot?.sessionId);
    const sessionId =
      typeof props.sessionId === 'string' && props.sessionId !== ''
        ? props.sessionId
        : typeof stored === 'string'
          ? stored
          : undefined;

    const state = useStore(store, () => {
      const dialog = store.dialog;
      return {
        starting: sessionId !== undefined && store.starting.has(sessionId),
        openHere: dialog !== null && dialog.sessionId === sessionId,
        notice: (sessionId === undefined ? null : store.notices.get(sessionId)) ?? null,
      };
    }, [sessionId]);

    const noSession = sessionId === undefined;
    const failure = state.notice !== null && state.notice.kind === 'error';
    const done = state.notice !== null && state.notice.kind === 'ok';
    const look = state.starting
      ? 'busy'
      : state.openHere
        ? 'plan'
        : failure
          ? 'error'
          : done
            ? 'done'
            : 'idle';
    const label = state.starting
      ? tr('action.busy')
      : state.openHere
        ? tr('action.open')
        : failure
          ? tr('action.failed')
          : done
            ? tr('action.cleanShort')
            : tr('action.label');
    // Failures and empty results both explain themselves on hover.
    const title = state.notice !== null ? state.notice.text : tr('action.title');

    const run = (): void => {
      if (noSession) return;
      // An open dialog owns the button; a finished one can be replaced.
      if (state.openHere && store.dialog?.phase !== 'done') return;
      void start(store, sessionId, tr);
    };

    return (
      <div className="dsh-sc-root">
        <style>{CSS}</style>
        <button
          type="button"
          className="dsh-sc-btn"
          data-state={look}
          title={noSession ? tr('action.noSession') : title}
          aria-label={title}
          disabled={state.starting || noSession}
          onClick={run}
        >
          <span className="dsh-sc-icon">{state.starting ? <Spinner /> : <CommitIcon />}</span>
          <span className="dsh-sc-label">{label}</span>
        </button>
      </div>
    );
  };
}

/**
 * Build the overlay dialog.
 * @param store - the page store.
 * @param ctx - the plugin context that owns locale.
 * @returns the slot component.
 */
export function createDialog(store: Store, ctx: ClientContext): React.ComponentType<SlotProps> {
  // biome-ignore lint/correctness/noComponentHookFactories: one component per store.
  return function SmartCommitDialog(props: SlotProps): React.ReactElement | null {
    const tr = translator(ctx, props);
    const dialog = useStore(store, () => store.dialog, []);
    const confirmRef = React.useRef<HTMLButtonElement | null>(null);
    const dialogRef = React.useRef<HTMLDivElement | null>(null);
    const phaseRef = React.useRef<Phase>('edit');
    phaseRef.current = dialog?.phase ?? 'edit';
    const menuRef = React.useRef(false);
    menuRef.current = dialog?.moveMenu === true;

    const close = (): void => {
      if (phaseRef.current === 'committing') return;
      closeDialog(store);
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the open/closed edge.
    React.useEffect(() => {
      if (dialog === null) return undefined;
      const previous = document.activeElement as HTMLElement | null;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        if (menuRef.current) {
          // Escape closes only the target menu; the dialog stays open.
          event.stopPropagation();
          if (store.dialog !== null) {
            store.dialog = { ...store.dialog, moveMenu: false };
            emit(store);
          }
          return;
        }
        if (phaseRef.current !== 'committing') {
          event.stopPropagation();
          closeDialog(store);
        }
      };
      document.addEventListener('keydown', onKey, true);
      const focusTarget = phaseRef.current === 'edit' ? confirmRef.current : dialogRef.current;
      focusTarget?.focus?.();
      return () => {
        document.removeEventListener('keydown', onKey, true);
        if (previous && typeof previous.focus === 'function') previous.focus();
      };
      // Re-run only when the dialog opens or closes, not on every keystroke.
    }, [dialog === null]);

    if (dialog === null) return null;

    const { plan, phase } = dialog;
    const missing =
      plan === null ? 0 : plan.groups.filter((group) => group.message.trim() === '').length;
    const fileCount =
      plan === null ? 0 : plan.groups.reduce((sum, group) => sum + group.files.length, 0);

    const branch =
      plan === null
        ? ''
        : plan.vcs === 'svn' && plan.revision !== undefined
          ? `${plan.branch}@r${plan.revision}`
          : plan.branch;

    const subtitle = (() => {
      if (phase === 'analyzing') return tr('dialog.analyzing');
      if (phase === 'naming' && plan !== null) {
        return tr('dialog.naming').replace('{model}', dialog.model ?? '');
      }
      if (plan === null) return dialog.error;
      return tr('dialog.summary')
        .replace('{groups}', String(plan.groups.length))
        .replace('{files}', String(fileCount));
    })();

    // Branch and VCS sit beside the summary as plain labels; no dot
    // separators, and they stay out of the way while the model is planning.
    const showMeta =
      plan !== null && phase !== 'analyzing' && phase !== 'naming' && phase !== 'error';

    const head = (
      <div className="dsh-sc-head">
        <div className="dsh-sc-head-text">
          <div className="dsh-sc-title">{tr('dialog.title')}</div>
          <div className="dsh-sc-subrow">
            <div className="dsh-sc-sub" title={subtitle}>
              {subtitle}
            </div>
            {showMeta && plan !== null && branch !== '' ? (
              <span className="dsh-sc-branch" title={branch}>
                {branch}
              </span>
            ) : null}
            {showMeta && plan !== null ? (
              <span className="dsh-sc-vcs">{String(plan.vcs).toUpperCase()}</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="dsh-sc-x"
          aria-label={tr('dialog.closeLabel')}
          title={tr('dialog.close')}
          disabled={phase === 'committing'}
          onClick={close}
        >
          {'\u00d7'}
        </button>
      </div>
    );

    const selectedCount = (dialog.selected ?? []).length;
    const setMoveMenu = (open: boolean): void => {
      if (store.dialog === null) return;
      store.dialog = { ...store.dialog, moveMenu: open };
      emit(store);
    };
    const selectionTools =
      phase === 'edit' && plan !== null && selectedCount > 0 ? (
        <div className="dsh-sc-selbar">
          <span className="dsh-sc-selcount" role="status" aria-live="polite">
            {tr('dialog.selected').replace('{n}', String(selectedCount))}
          </span>
          <div className="dsh-sc-dropdown">
            <button
              type="button"
              className="dsh-sc-moveto"
              aria-haspopup="menu"
              aria-expanded={dialog.moveMenu === true ? 'true' : 'false'}
              onClick={() => setMoveMenu(dialog.moveMenu !== true)}
            >
              <span>{tr('dialog.moveTo')}</span>
              <span className="dsh-sc-caret" aria-hidden="true" />
            </button>
            {dialog.moveMenu === true ? (
              <div className="dsh-sc-scrim" onClick={() => setMoveMenu(false)} aria-hidden="true" />
            ) : null}
            {dialog.moveMenu === true ? (
              <div className="dsh-sc-menu" role="menu" aria-label={tr('dialog.moveTo')}>
                {plan.groups.map((group, index) => (
                  <button
                    key={group.id}
                    type="button"
                    role="menuitem"
                    className="dsh-sc-menu-item"
                    onClick={() => moveSelected(store, group.id)}
                  >
                    <span>{tr('dialog.groupN').replace('{n}', String(index + 1))}</span>
                    <span className="dsh-sc-menu-count">
                      {tr('dialog.files').replace('{n}', String(group.files.length))}
                    </span>
                  </button>
                ))}
                <div className="dsh-sc-menu-sep" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="dsh-sc-menu-item"
                  onClick={() => moveSelected(store, 'new')}
                >
                  {tr('dialog.newGroup')}
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="dsh-sc-clear"
            title={tr('dialog.clearSelection')}
            aria-label={tr('dialog.clearSelection')}
            onClick={() => {
              if (store.dialog === null) return;
              store.dialog = { ...store.dialog, selected: [], moveMenu: false };
              emit(store);
            }}
          >
            {'\u00d7'}
          </button>
        </div>
      ) : null;

    const footer = (() => {
      if (phase === 'committing') {
        return (
          <div className="dsh-sc-foot">
            <span className="dsh-sc-foot-hint">{tr('dialog.committing')}</span>
            <button type="button" className="dsh-sc-ghost" disabled>
              {tr('dialog.cancel')}
            </button>
            <button type="button" className="dsh-sc-primary" disabled>
              {tr('dialog.committing')}
            </button>
          </div>
        );
      }
      if (phase === 'done') {
        return (
          <div className="dsh-sc-foot">
            <span className="dsh-sc-foot-hint">{''}</span>
            {dialog.ok ? null : (
              <button type="button" className="dsh-sc-ghost" onClick={() => restart(store, tr)}>
                {tr('dialog.reanalyze')}
              </button>
            )}
            <button type="button" className="dsh-sc-primary" onClick={() => closeDialog(store)}>
              {tr('dialog.close')}
            </button>
          </div>
        );
      }
      if (phase === 'error') {
        return (
          <div className="dsh-sc-foot">
            <span className="dsh-sc-foot-hint">{''}</span>
            <button type="button" className="dsh-sc-ghost" onClick={() => restart(store, tr)}>
              {tr('dialog.reanalyze')}
            </button>
            <button type="button" className="dsh-sc-primary" onClick={() => closeDialog(store)}>
              {tr('dialog.close')}
            </button>
          </div>
        );
      }
      if (phase === 'analyzing') {
        return (
          <div className="dsh-sc-foot">
            <span className="dsh-sc-foot-hint">{tr('dialog.analyzing')}</span>
            <button type="button" className="dsh-sc-ghost" onClick={() => closeDialog(store)}>
              {tr('dialog.cancel')}
            </button>
            <button type="button" className="dsh-sc-primary" disabled>
              {tr('dialog.confirm')}
            </button>
          </div>
        );
      }

      if (plan === null) return null;
      // `naming` and `edit` share the same footer shape.
      const hint =
        phase === 'naming'
          ? tr('dialog.naming').replace('{model}', dialog.model ?? '')
          : missing > 0
            ? tr('dialog.missing').replace('{n}', String(missing))
            : plan.staged.length > 0 && dialog.unstage !== true
              ? tr('dialog.needUnstage')
              : tr('dialog.hint');
      return (
        <div className="dsh-sc-foot">
          {selectionTools ?? (
            <span className="dsh-sc-foot-hint" title={hint}>
              {hint}
            </span>
          )}
          <button type="button" className="dsh-sc-ghost" onClick={close}>
            {tr('dialog.cancel')}
          </button>
          {dialog.stale === true ? (
            <button type="button" className="dsh-sc-ghost" onClick={() => restart(store, tr)}>
              {tr('dialog.reanalyze')}
            </button>
          ) : null}
          {dialog.stale !== true && dialog.useModel === true ? (
            <button
              type="button"
              className="dsh-sc-ghost"
              disabled={phase !== 'edit'}
              onClick={() => void regenerate(store, tr)}
            >
              {tr('dialog.regenerate')}
            </button>
          ) : null}
          <button
            type="button"
            className="dsh-sc-primary"
            ref={confirmRef}
            disabled={
              phase !== 'edit' ||
              dialog.stale === true ||
              missing > 0 ||
              (plan.staged.length > 0 && dialog.unstage !== true)
            }
            onClick={() => void commit(store)}
          >
            {tr('dialog.confirm')}
          </button>
        </div>
      );
    })();

    // Group cards are shared by naming, edit, and committing.
    const selected = new Set(dialog.selected ?? []);
    const expanded = new Set(dialog.expanded ?? []);
    const editable = phase === 'edit';
    const chipLimit = 8;
    const rows: React.ReactNode[] | null =
      plan === null
        ? null
        : plan.groups.map((group, index) => {
            const failure = dialog.failures.find((item) => item.index === index);
            const invalid = dialog.messageErrors.find((item) => item.index === index);
            const open = expanded.has(group.id);
            const allSelected = group.files.every((file) => selected.has(file));
            const shown = open ? group.files : group.files.slice(0, chipLimit);
            const hidden = group.files.length - shown.length;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: group cards implement drag-and-drop.
              <div
                key={group.id}
                className="dsh-sc-group"
                data-over={dialog.overId === group.id ? 'true' : undefined}
                onDragOver={(event) => {
                  if (!editable) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dialog.overId !== group.id && store.dialog !== null) {
                    store.dialog = { ...store.dialog, overId: group.id };
                    emit(store);
                  }
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  if (dialog.overId === group.id && store.dialog !== null) {
                    store.dialog = { ...store.dialog, overId: '' };
                    emit(store);
                  }
                }}
                onDrop={(event) => {
                  if (!editable) return;
                  event.preventDefault();
                  moveFiles(store, [event.dataTransfer.getData('text/plain')], group.id);
                }}
              >
                <div className="dsh-sc-group-head">
                  <span className="dsh-sc-idx">{String(index + 1)}</span>
                  <div className="dsh-sc-field">
                    <textarea
                      className="dsh-sc-input"
                      value={group.message}
                      rows={Math.max(1, group.message.split('\n').length)}
                      spellCheck={false}
                      disabled={!editable}
                      data-loading={phase === 'naming' ? 'true' : undefined}
                      placeholder={group.suggestion || tr('dialog.placeholder')}
                      aria-label={`commit message ${index + 1}`}
                      ref={(node) => {
                        if (node === null) return;
                        node.style.height = 'auto';
                        node.style.height = `${node.scrollHeight}px`;
                      }}
                      onChange={(event) => {
                        updateMessage(store, index, event.target.value);
                        event.target.style.height = 'auto';
                        event.target.style.height = `${event.target.scrollHeight}px`;
                      }}
                      // A dropped chip must not paste its path into the message.
                      onDrop={(event) => event.preventDefault()}
                    />
                    <div className="dsh-sc-meta">
                      <span className="dsh-sc-count">
                        {tr('dialog.files').replace('{n}', String(group.files.length))}
                      </span>
                      {group.edited === true ? (
                        <span className="dsh-sc-tag">{tr('dialog.edited')}</span>
                      ) : null}
                    </div>
                    {failure !== undefined ? (
                      <div className="dsh-sc-line" data-kind="warn">
                        {tr('dialog.modelMissing').replace('{reason}', failure.reason)}
                      </div>
                    ) : null}
                    {invalid !== undefined ? (
                      <div className="dsh-sc-line" data-kind="error">
                        {tr('dialog.invalid').replace('{reason}', invalid.reason)}
                      </div>
                    ) : null}
                  </div>
                  {index > 0 ? (
                    <button
                      type="button"
                      className="dsh-sc-tool"
                      title={tr('dialog.mergeUp')}
                      aria-label={tr('dialog.mergeUp')}
                      disabled={!editable}
                      onClick={() => mergeUp(store, group.id)}
                    >
                      {'\u2191'}
                    </button>
                  ) : null}
                </div>
                <div
                  className="dsh-sc-chips"
                  data-selecting={selected.size > 0 ? 'true' : undefined}
                >
                  {shown.map((file) => (
                    <button
                      key={file}
                      type="button"
                      className="dsh-sc-chip"
                      title={file}
                      draggable={editable}
                      disabled={!editable}
                      aria-pressed={selected.has(file)}
                      data-selected={selected.has(file) ? 'true' : undefined}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', file);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => {
                        if (store.dialog !== null && store.dialog.overId !== '') {
                          store.dialog = { ...store.dialog, overId: '' };
                          emit(store);
                        }
                      }}
                      onClick={(event) =>
                        toggleSelected(store, file, {
                          groupId: group.id,
                          shift: event.shiftKey,
                        })
                      }
                    >
                      {file}
                    </button>
                  ))}
                  {hidden > 0 ? (
                    <button
                      type="button"
                      className="dsh-sc-chip dsh-sc-chip-more"
                      onClick={() => toggleExpanded(store, group.id)}
                    >
                      {tr('dialog.more').replace('{n}', String(hidden))}
                    </button>
                  ) : null}
                  {open && group.files.length > chipLimit ? (
                    <button
                      type="button"
                      className="dsh-sc-chip dsh-sc-chip-more"
                      onClick={() => toggleExpanded(store, group.id)}
                    >
                      {tr('dialog.collapse')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="dsh-sc-gsel"
                    title={
                      allSelected
                        ? tr('dialog.clearGroup')
                        : tr('dialog.selectGroup').replace('{n}', String(group.files.length))
                    }
                    aria-label={
                      allSelected
                        ? tr('dialog.clearGroup')
                        : tr('dialog.selectGroup').replace('{n}', String(group.files.length))
                    }
                    aria-pressed={allSelected ? 'true' : 'false'}
                    data-checked={allSelected ? 'true' : undefined}
                    disabled={!editable}
                    onClick={() => toggleSelectedInGroup(store, group)}
                  >
                    {allSelected ? '\u2713' : ''}
                  </button>
                </div>
              </div>
            );
          });

    let body: React.ReactNode;
    if (phase === 'analyzing') {
      body = (
        <div className="dsh-sc-body">
          <Progress text={tr('dialog.analyzing')} />
          <Skeleton />
        </div>
      );
    } else if (phase === 'error') {
      body = (
        <div className="dsh-sc-body">
          <pre className="dsh-sc-pre dsh-sc-error">{dialog.error}</pre>
        </div>
      );
    } else if (phase === 'done') {
      body = (
        <div className="dsh-sc-body">
          <div className="dsh-sc-title">{tr('dialog.done')}</div>
          <pre className="dsh-sc-pre">{dialog.result}</pre>
        </div>
      );
    } else if (plan === null) {
      body = null;
    } else {
      const progress =
        phase === 'naming' ? (
          <Progress text={tr('dialog.naming').replace('{model}', dialog.model ?? '')} />
        ) : phase === 'committing' ? (
          <Progress text={tr('dialog.committing')} />
        ) : null;
      body = (
        <div className="dsh-sc-body">
          {progress}
          {dialog.error !== '' ? (
            <div className="dsh-sc-warn" role="alert">
              {dialog.error}
            </div>
          ) : null}
          {phase === 'edit' ? <div className="dsh-sc-note">{tr('dialog.regroupHint')}</div> : null}
          {rows ?? []}
          {plan.skipped.length > 0 ? (
            <div className="dsh-sc-warn">
              {tr('dialog.skipped')
                .replace('{n}', String(plan.skipped.length))
                .replace('{paths}', plan.skipped.join('\u3001'))}
            </div>
          ) : null}
          {plan.vcs === 'svn' ? <div className="dsh-sc-note">{tr('dialog.svnNote')}</div> : null}
          {plan.staged.length > 0 ? (
            <div className="dsh-sc-warn">
              <div>{tr('dialog.staged').replace('{n}', String(plan.staged.length))}</div>
              <div className="dsh-sc-warn-paths">{plan.staged.join('\n')}</div>
              <label className="dsh-sc-check">
                <input
                  type="checkbox"
                  checked={dialog.unstage === true}
                  disabled={phase !== 'edit'}
                  onChange={() => toggleUnstage(store)}
                />
                <span>{tr('dialog.stagedBox')}</span>
              </label>
            </div>
          ) : null}
          {plan.warnings.length > 0 ? (
            <div className="dsh-sc-warn">{plan.warnings.join('\uFF1B')}</div>
          ) : null}
          {dialog.note !== '' ? <div className="dsh-sc-note">{dialog.note}</div> : null}
        </div>
      );
    }

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on an outside click.
      <div
        className="dsh-sc-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div
          className="dsh-sc-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={tr('dialog.title')}
          tabIndex={-1}
          ref={dialogRef}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <style>{CSS}</style>
          {head}
          {body}
          {footer}
        </div>
      </div>
    );
  };
}

/** Re-exported for the slot registration in `index.tsx`. */
export { NS };
