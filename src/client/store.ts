/**
 * The page-level store and its pure regrouping operations.
 *
 * The button and the overlay dialog share one store. Every operation here is
 * synchronous bookkeeping: no React, no fetch, no timers except the transient
 * notice. That is what makes the regrouping rules testable without a browser.
 */

import type { GroupFailure, WireGroup, WirePlan } from '../shared/contract.js';

export type Phase = 'analyzing' | 'naming' | 'edit' | 'committing' | 'done' | 'error';

/** A wire group with the Client's stable identity and edit marker. */
export interface ClientGroup extends WireGroup {
  id: string;
  edited: boolean;
}

/** The plan the dialog edits, derived from the Host's wire plan. */
export interface ClientPlan extends Omit<WirePlan, 'groups'> {
  groups: ClientGroup[];
}

export interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

export interface LastPicked {
  groupId: string;
  path: string;
}

export interface DialogState {
  requestId: number;
  sessionId: string;
  controller: AbortController;
  phase: Phase;
  plan: ClientPlan | null;
  model: string | null;
  useModel: boolean;
  note: string;
  failures: GroupFailure[];
  messageErrors: GroupFailure[];
  error: string;
  stale: boolean;
  result: string;
  ok: boolean;
  unstage: boolean;
  selected: string[];
  expanded: string[];
  overId: string;
  lastPicked: LastPicked | null;
  moveMenu?: boolean;
}

export interface Store {
  dialog: DialogState | null;
  notices: Map<string, Notice>;
  listeners: Set<() => void>;
  starting: Set<string>;
  seq: number;
}

export function createStore(): Store {
  return {
    dialog: null,
    notices: new Map(),
    listeners: new Set(),
    starting: new Set(),
    seq: 0,
  };
}

export function emit(store: Store): void {
  for (const listener of store.listeners) listener();
}

export function isCurrent(store: Store, requestId: number): boolean {
  return store.dialog !== null && store.dialog.requestId === requestId;
}

export function closeDialog(store: Store): void {
  const dialog = store.dialog;
  if (dialog !== null && typeof dialog.controller?.abort === 'function') {
    dialog.controller.abort();
  }
  store.dialog = null;
  emit(store);
}

export function setNotice(
  store: Store,
  sessionId: string,
  kind: Notice['kind'],
  text: string,
  ttl = 6000,
): void {
  if (text === '') {
    store.notices.delete(sessionId);
  } else {
    store.notices.set(sessionId, { kind, text });
    if (ttl > 0) {
      setTimeout(() => {
        const current = store.notices.get(sessionId);
        if (current !== undefined && current.text === text) {
          store.notices.delete(sessionId);
          emit(store);
        }
      }, ttl);
    }
  }
  emit(store);
}

/** Client-side group ids, so a card keeps its identity while regrouping. */
let groupSeq = 0;

function nextGroupId(): string {
  groupSeq += 1;
  return `group-${groupSeq}`;
}

/** Attach a stable id and an `edited` flag to every group of a fresh plan. */
export function preparePlan(plan: WirePlan): ClientPlan {
  return {
    ...plan,
    groups: plan.groups.map((group) => ({
      ...group,
      id: typeof group.id === 'string' && group.id !== '' ? group.id : nextGroupId(),
      edited: group.edited === true,
    })),
  };
}

/**
 * Toggle one path in the current selection.
 * @param store - the page store.
 * @param path - the file chip that was clicked.
 * @param options - its group id, and whether Shift extends the selection.
 */
export function toggleSelected(
  store: Store,
  path: string,
  { groupId = '', shift = false }: { groupId?: string; shift?: boolean } = {},
): void {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit') return;
  let selected: string[] | undefined;
  if (shift === true && dialog.lastPicked?.groupId === groupId) {
    const group = dialog.plan?.groups.find((item) => item.id === groupId);
    const from = group === undefined ? -1 : group.files.indexOf(dialog.lastPicked.path);
    const to = group === undefined ? -1 : group.files.indexOf(path);
    if (group !== undefined && from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      selected = [...new Set([...dialog.selected, ...group.files.slice(start, end + 1)])];
    }
  }
  if (selected === undefined) {
    selected = dialog.selected.includes(path)
      ? dialog.selected.filter((item) => item !== path)
      : [...dialog.selected, path];
  }
  store.dialog = { ...dialog, selected, lastPicked: { groupId, path } };
  emit(store);
}

/** Select every file of one group, or clear them when all are selected. */
export function toggleSelectedInGroup(store: Store, group: ClientGroup | undefined): void {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit' || group === undefined) return;
  const files = new Set(group.files);
  const all = group.files.every((file) => dialog.selected.includes(file));
  const selected = all
    ? dialog.selected.filter((file) => !files.has(file))
    : [...new Set([...dialog.selected, ...group.files])];
  store.dialog = { ...dialog, selected, lastPicked: null };
  emit(store);
}

/** Expand or collapse a group's file chips. */
export function toggleExpanded(store: Store, id: string): void {
  const dialog = store.dialog;
  if (dialog === null) return;
  const expanded = dialog.expanded.includes(id)
    ? dialog.expanded.filter((item) => item !== id)
    : [...dialog.expanded, id];
  store.dialog = { ...dialog, expanded };
  emit(store);
}

/**
 * Move paths into another group, or into a brand-new one.
 * @param store - the page store.
 * @param paths - repository-relative paths that travel together.
 * @param targetId - an existing group id, or anything else for a new group.
 */
export function moveFiles(store: Store, paths: readonly string[], targetId: string): void {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit' || dialog.plan === null) return;
  const moving = new Set(paths.filter((path) => typeof path === 'string' && path !== ''));
  if (moving.size === 0) return;

  const current = dialog.plan.groups.find((group) => group.id === targetId);
  if (current !== undefined && [...moving].every((path) => current.files.includes(path))) {
    store.dialog = { ...dialog, overId: '' };
    emit(store);
    return;
  }

  const anchor = dialog.plan.groups.find((group) => group.files.some((file) => moving.has(file)));
  const sourceIds = new Set(
    dialog.plan.groups
      .filter((group) => group.files.some((file) => moving.has(file)))
      .map((group) => group.id),
  );
  const groups: ClientGroup[] = dialog.plan.groups.map((group) => ({
    ...group,
    files: group.files.filter((file) => !moving.has(file)),
  }));
  let target = groups.find((group) => group.id === targetId);
  if (target === undefined) {
    target = {
      id: nextGroupId(),
      type: anchor?.type ?? 'refactor',
      scope: anchor?.scope ?? '',
      message: '',
      suggestion: '',
      files: [],
      edited: true,
    };
    groups.push(target);
  }
  target.files = [...new Set([...target.files, ...moving])].sort();
  target.edited = true;
  for (const group of groups) {
    // A group that lost files may no longer match its message.
    if (group.id !== target.id && sourceIds.has(group.id)) group.edited = true;
  }
  const kept = groups.filter((group) => group.files.length > 0);
  store.dialog = {
    ...dialog,
    moveMenu: false,
    plan: { ...dialog.plan, groups: kept },
    selected: dialog.selected.filter((path) => !moving.has(path)),
    expanded: dialog.expanded.filter((id) => kept.some((group) => group.id === id)),
    overId: '',
    error: '',
    messageErrors: [],
  };
  emit(store);
}

/** Move everything currently selected to the chosen target. */
export function moveSelected(store: Store, targetId: string): void {
  const dialog = store.dialog;
  if (dialog === null) return;
  store.dialog = { ...dialog, moveMenu: false };
  moveFiles(store, dialog.selected, targetId);
}

/** Merge a group into the one above it, keeping the target's message. */
export function mergeUp(store: Store, id: string): void {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit' || dialog.plan === null) return;
  const index = dialog.plan.groups.findIndex((group) => group.id === id);
  if (index <= 0) return;
  const previous = dialog.plan.groups[index - 1];
  const group = dialog.plan.groups[index];
  const merged: ClientGroup = {
    ...previous,
    files: [...new Set([...previous.files, ...group.files])].sort(),
    edited: true,
  };
  if (merged.message.trim() === '' && group.message.trim() !== '') {
    merged.message = group.message;
    merged.suggestion = group.suggestion || merged.suggestion;
  }
  const groups = dialog.plan.groups
    .map((item, position) => (position === index - 1 ? merged : item))
    .filter((_item, position) => position !== index);
  store.dialog = {
    ...dialog,
    plan: { ...dialog.plan, groups },
    error: '',
    messageErrors: [],
  };
  emit(store);
}

/** Update one group's editable message. */
export function updateMessage(store: Store, index: number, value: string): void {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit' || dialog.plan === null) return;
  const plan: ClientPlan = {
    ...dialog.plan,
    groups: dialog.plan.groups.map((group, position) =>
      position === index ? { ...group, message: value } : group,
    ),
  };
  store.dialog = {
    ...dialog,
    plan,
    error: '',
    messageErrors: dialog.messageErrors.filter((item) => item.index !== index),
  };
  emit(store);
}

/** Toggle the "release the index first" checkbox. */
export function toggleUnstage(store: Store): void {
  const dialog = store.dialog;
  if (dialog === null || dialog.phase !== 'edit') return;
  store.dialog = { ...dialog, unstage: dialog.unstage !== true, error: '' };
  emit(store);
}
