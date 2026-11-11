import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ClientPlan,
  createStore,
  mergeUp,
  moveFiles,
  moveSelected,
  preparePlan,
  type Store,
  toggleExpanded,
  toggleSelected,
  toggleSelectedInGroup,
} from '../src/client/store.js';
import type { WireGroup } from '../src/shared/contract.js';

/**
 * The regrouping rules are pure store operations: no React and no module
 * loader. These tests exercise exactly the bookkeeping the dialog runs.
 */

/** Install a dialog around the given groups. */
function openDialog(groups: WireGroup[]): { store: Store; plan: ClientPlan } {
  const store = createStore();
  const plan = preparePlan({
    vcs: 'git',
    branch: 'main',
    hasHead: true,
    staged: [],
    skipped: [],
    warnings: [],
    untracked: [],
    added: [],
    groups,
  });
  store.dialog = {
    requestId: 1,
    sessionId: 'session-1',
    controller: new AbortController(),
    phase: 'edit',
    plan,
    useModel: true,
    model: 'deepseek-official/deepseek-flash',
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
  return { store, plan };
}

/** Groups used by most cases: two source groups and one docs group. */
function sampleGroups(): WireGroup[] {
  return [
    {
      type: 'feat',
      scope: 'api',
      message: 'feat(api): 新增接口',
      suggestion: '',
      files: ['api/a.js', 'api/b.js'],
    },
    {
      type: 'refactor',
      scope: 'src',
      message: 'refactor(src): 整理模块',
      suggestion: '',
      files: ['src/c.js'],
    },
    {
      type: 'docs',
      scope: '',
      message: 'docs: 补充说明',
      suggestion: '',
      files: ['README.md'],
    },
  ];
}

/** Narrow the dialog the store must have after `openDialog`. */
function dialogOf(store: Store) {
  const dialog = store.dialog;
  assert.ok(dialog !== null);
  return dialog;
}

test('preparePlan gives every group a stable id and an edited flag', () => {
  const { plan } = openDialog(sampleGroups());
  assert.equal(plan.groups.length, 3);
  assert.equal(new Set(plan.groups.map((group) => group.id)).size, 3);
  for (const group of plan.groups) assert.equal(group.edited, false);
});

test('clicking files builds a selection and clicking again clears it', () => {
  const { store } = openDialog(sampleGroups());
  toggleSelected(store, 'api/a.js');
  toggleSelected(store, 'README.md');
  assert.deepEqual(dialogOf(store).selected, ['api/a.js', 'README.md']);
  toggleSelected(store, 'api/a.js');
  assert.deepEqual(dialogOf(store).selected, ['README.md']);
});

test('shift-click extends the selection inside one group', () => {
  const { store, plan } = openDialog([
    {
      type: 'refactor',
      scope: 'src',
      message: 'refactor(src): 整理模块',
      suggestion: '',
      files: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'],
    },
  ]);
  const id = plan.groups[0].id;
  toggleSelected(store, 'src/a.js', { groupId: id });
  toggleSelected(store, 'src/c.js', { groupId: id, shift: true });
  assert.deepEqual(dialogOf(store).selected, ['src/a.js', 'src/b.js', 'src/c.js']);
  // A Shift-click in another group starts a plain toggle instead of a range.
  toggleSelected(store, 'src/d.js', { groupId: id, shift: true });
  assert.equal(dialogOf(store).selected.includes('src/d.js'), true);
});

test('one click selects a whole group, the next clears it', () => {
  const { store, plan } = openDialog(sampleGroups());
  const first = plan.groups[0];
  toggleSelectedInGroup(store, first);
  assert.deepEqual([...dialogOf(store).selected].sort(), ['api/a.js', 'api/b.js']);
  toggleSelectedInGroup(store, first);
  assert.deepEqual(dialogOf(store).selected, []);
});

test('moving selected files into another group drops the emptied group', () => {
  const { store, plan } = openDialog(sampleGroups());
  const [first, second] = plan.groups;
  toggleSelected(store, 'api/a.js');
  toggleSelected(store, 'api/b.js');
  moveSelected(store, second.id);
  const groups = dialogOf(store).plan?.groups ?? [];
  assert.equal(groups.length, 2);
  const target = groups.find((group) => group.id === second.id);
  assert.ok(target !== undefined);
  assert.deepEqual(target.files, ['api/a.js', 'api/b.js', 'src/c.js']);
  assert.equal(target.edited, true);
  assert.equal(
    groups.some((group) => group.id === first.id),
    false,
  );
  assert.deepEqual(dialogOf(store).selected, []);
});

test('moving files into a new group starts with an empty message', () => {
  const { store, plan } = openDialog(sampleGroups());
  const docs = plan.groups[2];
  toggleSelected(store, 'README.md');
  moveSelected(store, 'new');
  const groups = dialogOf(store).plan?.groups ?? [];
  assert.equal(groups.length, 3);
  const created = groups.find((group) => group.id !== docs.id && group.files.includes('README.md'));
  assert.ok(created !== undefined);
  assert.deepEqual(created.files, ['README.md']);
  assert.equal(created.message, '');
  assert.equal(created.type, 'docs');
  assert.equal(created.edited, true);
  // The emptied rule group is gone.
  assert.equal(
    groups.some((group) => group.id === docs.id),
    false,
  );
});

test('dropping files onto their own group changes nothing', () => {
  const { store, plan } = openDialog(sampleGroups());
  const first = plan.groups[0];
  moveFiles(store, ['api/a.js'], first.id);
  const groups = dialogOf(store).plan?.groups ?? [];
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].files, ['api/a.js', 'api/b.js']);
  assert.equal(groups[0].edited, false);
});

test('a group that loses files is marked as edited too', () => {
  const { store, plan } = openDialog(sampleGroups());
  const first = plan.groups[0];
  moveFiles(store, ['api/a.js'], plan.groups[1].id);
  const groups = dialogOf(store).plan?.groups ?? [];
  const source = groups.find((group) => group.id === first.id);
  assert.ok(source !== undefined);
  assert.deepEqual(source.files, ['api/b.js']);
  assert.equal(source.edited, true);
  const target = groups.find((group) => group.id === plan.groups[1].id);
  assert.ok(target !== undefined);
  assert.equal(target.edited, true);
});

test('merging up keeps the target message and removes the source group', () => {
  const { store, plan } = openDialog(sampleGroups());
  const [first, second] = plan.groups;
  mergeUp(store, second.id);
  const groups = dialogOf(store).plan?.groups ?? [];
  assert.equal(groups.length, 2);
  const merged = groups.find((group) => group.id === first.id);
  assert.ok(merged !== undefined);
  assert.deepEqual(merged.files, ['api/a.js', 'api/b.js', 'src/c.js']);
  assert.equal(merged.message, 'feat(api): 新增接口');
  assert.equal(merged.edited, true);
  assert.equal(
    groups.some((group) => group.id === second.id),
    false,
  );
});

test('merging into a group with no message adopts the merged message', () => {
  const groups = sampleGroups();
  groups[0].message = '';
  groups[0].suggestion = 'feat(api): 新增接口';
  const { store, plan } = openDialog(groups);
  mergeUp(store, plan.groups[1].id);
  const merged = dialogOf(store).plan?.groups[0];
  assert.ok(merged !== undefined);
  assert.equal(merged.message, 'refactor(src): 整理模块');
  assert.equal(merged.suggestion, 'feat(api): 新增接口');
});

test('expanding and collapsing a group is independent of the plan', () => {
  const { store, plan } = openDialog(sampleGroups());
  const id = plan.groups[0].id;
  toggleExpanded(store, id);
  assert.deepEqual(dialogOf(store).expanded, [id]);
  toggleExpanded(store, id);
  assert.deepEqual(dialogOf(store).expanded, []);
});

test('regrouping clears stale validation and keeps the rest of the plan', () => {
  const { store, plan } = openDialog(sampleGroups());
  const dialog = dialogOf(store);
  dialog.messageErrors = [{ index: 0, reason: '旧错误' }];
  dialog.error = '旧错误';
  moveFiles(store, ['api/a.js'], plan.groups[1].id);
  const after = dialogOf(store);
  assert.deepEqual(after.messageErrors, []);
  assert.equal(after.error, '');
  assert.deepEqual(after.plan?.staged, []);
  assert.equal(after.plan?.branch, 'main');
});
