/**
 * The dialog's lifecycle: analyze, name, commit, and the recovery paths.
 *
 * The UI only calls these functions; every state transition and every error
 * mapping lives here, so the React components stay declarative and the flow
 * can be reviewed without reading JSX.
 */

import type {
  AnalyzeResult,
  CommitResult,
  EmptyResult,
  GroupFailure,
  NameResult,
} from '../shared/contract.js';
import { ClientApiError, call } from './api.js';
import type { Translator } from './i18n.js';
import type { ClientPlan, Store } from './store.js';
import { closeDialog, emit, isCurrent, preparePlan, setNotice } from './store.js';

const ANALYZE_TIMEOUT_MS = 60000;
const NAME_TIMEOUT_MS = 180000;
const COMMIT_TIMEOUT_MS = 180000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof ClientApiError ? error.code : '';
}

/** Analyze, then name; the dialog is on screen from the first phase. */
export async function start(
  store: Store,
  sessionId: string | undefined,
  tr: Translator,
): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId === '') {
    setNotice(store, '', 'error', tr('action.noSession'), 0);
    return;
  }
  if (
    store.dialog !== null &&
    store.dialog.sessionId === sessionId &&
    store.dialog.phase !== 'done' &&
    store.dialog.phase !== 'error'
  ) {
    return;
  }
  if (store.starting.has(sessionId)) return;
  if (store.dialog !== null) closeDialog(store);
  // A new attempt owns the button again; drop the previous result note.
  store.notices.delete(sessionId);

  store.starting.add(sessionId);
  const requestId = ++store.seq;
  const controller = new AbortController();
  store.dialog = {
    requestId,
    sessionId,
    controller,
    phase: 'analyzing',
    plan: null,
    model: null,
    useModel: false,
    note: '',
    failures: [],
    messageErrors: [],
    error: '',
    stale: false,
    result: '',
    ok: true,
    unstage: false,
    selected: [],
    expanded: [],
    overId: '',
    lastPicked: null,
  };
  emit(store);

  try {
    let analyzed: AnalyzeResult | EmptyResult;
    try {
      analyzed = await call<AnalyzeResult | EmptyResult>(
        'analyze',
        { sessionId },
        { signal: controller.signal, timeoutMs: ANALYZE_TIMEOUT_MS },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      store.dialog = null;
      setNotice(
        store,
        sessionId,
        errorCode(error) === 'clean' ? 'ok' : 'error',
        errorMessage(error),
        9000,
      );
      return;
    }
    if (!isCurrent(store, requestId)) return;
    if (analyzed.empty === true) {
      store.dialog = null;
      setNotice(store, sessionId, 'ok', analyzed.message, 9000);
      return;
    }

    const analyzingDialog = store.dialog;
    if (analyzingDialog === null) return;
    store.dialog = {
      ...analyzingDialog,
      phase: analyzed.useModel ? 'naming' : 'edit',
      plan: preparePlan(analyzed.plan),
      useModel: analyzed.useModel === true,
      model: analyzed.model,
      note: analyzed.useModel ? '' : tr('dialog.manual'),
    };
    emit(store);

    if (!analyzed.useModel) return;
    try {
      const named = await call<NameResult | EmptyResult>(
        'name',
        { sessionId },
        { signal: controller.signal, timeoutMs: NAME_TIMEOUT_MS },
      );
      if (!isCurrent(store, requestId)) return;
      if (named.empty === true) {
        store.dialog = null;
        setNotice(store, sessionId, 'ok', named.message, 9000);
        return;
      }
      const namingDialog = store.dialog;
      if (namingDialog === null) return;
      store.dialog = {
        ...namingDialog,
        phase: 'edit',
        plan: preparePlan(named.plan),
        model: named.model,
        note: named.note,
        failures: Array.isArray(named.failures) ? named.failures : [],
        selected: [],
        expanded: [],
        overId: '',
      };
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!isCurrent(store, requestId)) return;
      const current = store.dialog;
      if (current === null) return;
      store.dialog = {
        ...current,
        phase: 'edit',
        error: tr('dialog.modelFailed').replace('{reason}', errorMessage(error)),
      };
    }
  } finally {
    store.starting.delete(sessionId);
    emit(store);
  }
}

/** Re-run only the model step, keeping the dialog's request id. */
export async function regenerate(store: Store, tr: Translator): Promise<void> {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit' || dialog.useModel !== true) return;
  const { requestId, sessionId, controller } = dialog;
  store.dialog = {
    ...dialog,
    phase: 'naming',
    error: '',
    stale: false,
    failures: [],
    messageErrors: [],
    selected: [],
    expanded: [],
    overId: '',
  };
  emit(store);
  try {
    const named = await call<NameResult | EmptyResult>(
      'name',
      { sessionId },
      { signal: controller.signal, timeoutMs: NAME_TIMEOUT_MS },
    );
    if (!isCurrent(store, requestId)) return;
    if (named.empty === true) {
      store.dialog = null;
      setNotice(store, sessionId, 'ok', named.message, 9000);
      return;
    }
    const current = store.dialog;
    if (current === null) return;
    store.dialog = {
      ...current,
      phase: 'edit',
      plan: preparePlan(named.plan),
      model: named.model,
      note: named.note,
      stale: false,
      failures: Array.isArray(named.failures) ? named.failures : [],
      messageErrors: [],
      selected: [],
      expanded: [],
      overId: '',
    };
  } catch (error) {
    if (controller.signal.aborted) return;
    if (!isCurrent(store, requestId)) return;
    const current = store.dialog;
    if (current === null) return;
    store.dialog = {
      ...current,
      phase: 'edit',
      error: tr('dialog.modelFailed').replace('{reason}', errorMessage(error)),
    };
  } finally {
    emit(store);
  }
}

export function restart(store: Store, tr: Translator): void {
  const dialog = store.dialog;
  if (dialog === null) return;
  const sessionId = dialog.sessionId;
  closeDialog(store);
  void start(store, sessionId, tr);
}

/** Commit the confirmed plan and map the Host's failures back into the dialog. */
export async function commit(store: Store): Promise<void> {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit' || dialog.plan === null) return;
  const messages = dialog.plan.groups.map((group) => group.message);
  if (messages.some((message) => message.trim() === '')) return;
  if (dialog.plan.staged.length > 0 && dialog.unstage !== true) return;

  store.dialog = {
    ...dialog,
    phase: 'committing',
    error: '',
    messageErrors: [],
    moveMenu: false,
  };
  emit(store);
  try {
    const result = await call<CommitResult>(
      'commit',
      {
        sessionId: dialog.sessionId,
        plan: dialog.plan,
        messages,
        unstage: dialog.unstage === true,
      },
      { signal: dialog.controller.signal, timeoutMs: COMMIT_TIMEOUT_MS },
    );
    if (!isCurrent(store, dialog.requestId)) return;
    const current = store.dialog;
    if (current === null) return;
    store.dialog = {
      ...current,
      phase: 'done',
      ok: result.ok === true,
      result: result.text ?? '',
    };
  } catch (error) {
    if (dialog.controller.signal.aborted) return;
    if (!isCurrent(store, dialog.requestId)) return;
    const current = store.dialog;
    if (current === null) return;
    const code = errorCode(error);
    const details = error instanceof ClientApiError ? error.details : undefined;
    const failureDetails =
      details !== null && typeof details === 'object'
        ? (details as { groups?: unknown; paths?: unknown })
        : {};
    const groups: GroupFailure[] =
      code === 'invalid-message' && Array.isArray(failureDetails.groups)
        ? (failureDetails.groups as GroupFailure[])
        : [];
    const stagedPaths =
      code === 'staged' && Array.isArray(failureDetails.paths)
        ? (failureDetails.paths as string[])
        : null;
    const plan: ClientPlan | null =
      stagedPaths === null || current.plan === null
        ? current.plan
        : { ...current.plan, staged: stagedPaths };
    store.dialog = {
      ...current,
      phase: 'edit',
      moveMenu: false,
      error: errorMessage(error),
      messageErrors: groups,
      stale: code === 'stale',
      plan,
    };
  } finally {
    emit(store);
  }
}
