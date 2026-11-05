import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Client half is a browser bundle: it registers itself on
 * `window.__ModuleLoader__` and takes React from the host's module table.
 * These tests load it with the smallest possible stand-ins, then drive the
 * regrouping bookkeeping directly through its test hooks.
 */
let plugin;

globalThis.window = {
  __DSH_SMART_COMMIT_TEST__: true,
  __ModuleLoader__: {
    load({ factory }) {
      plugin = factory(fakeRequire);
    },
  },
};

function fakeRequire(name) {
  if (name !== 'react') throw new Error(`unexpected module: ${name}`);
  return {
    createElement() {
      return null;
    },
    useState() {},
    useEffect() {},
    useRef() {},
    useMemo(value) {
      return value;
    },
  };
}

await import('../client.js');

const {
  store,
  preparePlan,
  moveFiles,
  moveSelected,
  mergeUp,
  toggleSelected,
  toggleSelectedInGroup,
  toggleExpanded,
} = plugin.__test;

/**
 * Install a dialog around the given groups.
 * @param groups - host-shaped groups without ids.
 * @returns the prepared plan.
 */
function openDialog(groups) {
  const plan = preparePlan({
    vcs: 'git',
    branch: 'main',
    hasHead: true,
    staged: [],
    skipped: [],
    warnings: [],
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
    moveTarget: 'new',
    lastPicked: null,
  };
  return plan;
}

/** Groups used by most cases: two source groups and one docs group. */
function sampleGroups() {
  return [
    { type: 'feat', scope: 'api', message: 'feat(api): 新增接口', suggestion: '', files: ['api/a.js', 'api/b.js'] },
    { type: 'refactor', scope: 'src', message: 'refactor(src): 整理模块', suggestion: '', files: ['src/c.js'] },
    { type: 'docs', scope: '', message: 'docs: 补充说明', suggestion: '', files: ['README.md'] },
  ];
}

test.afterEach(() => {
  store.dialog = null;
});

test('preparePlan gives every group a stable id and an edited flag', () => {
  const plan = openDialog(sampleGroups());
  assert.equal(plan.groups.length, 3);
  assert.equal(new Set(plan.groups.map((group) => group.id)).size, 3);
  for (const group of plan.groups) assert.equal(group.edited, false);
});

test('clicking files builds a selection and clicking again clears it', () => {
  openDialog(sampleGroups());
  toggleSelected('api/a.js');
  toggleSelected('README.md');
  assert.deepEqual(store.dialog.selected, ['api/a.js', 'README.md']);
  toggleSelected('api/a.js');
  assert.deepEqual(store.dialog.selected, ['README.md']);
});

test('shift-click extends the selection inside one group', () => {
  const plan = openDialog([
    {
      type: 'refactor',
      scope: 'src',
      message: 'refactor(src): 整理模块',
      suggestion: '',
      files: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'],
    },
  ]);
  const id = plan.groups[0].id;
  toggleSelected('src/a.js', { groupId: id });
  toggleSelected('src/c.js', { groupId: id, shift: true });
  assert.deepEqual(store.dialog.selected, ['src/a.js', 'src/b.js', 'src/c.js']);
  // A Shift-click in another group starts a plain toggle instead of a range.
  toggleSelected('src/d.js', { groupId: id, shift: true });
  assert.equal(store.dialog.selected.includes('src/d.js'), true);
});

test('one click selects a whole group, the next clears it', () => {
  const plan = openDialog(sampleGroups());
  const first = plan.groups[0];
  toggleSelectedInGroup(first);
  assert.deepEqual([...store.dialog.selected].sort(), ['api/a.js', 'api/b.js']);
  toggleSelectedInGroup(first);
  assert.deepEqual(store.dialog.selected, []);
});

test('moving selected files into another group drops the emptied group', () => {
  const plan = openDialog(sampleGroups());
  const [first, second] = plan.groups;
  toggleSelected('api/a.js');
  toggleSelected('api/b.js');
  moveSelected(second.id);
  const groups = store.dialog.plan.groups;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((group) => group.id === second.id).files, ['api/a.js', 'api/b.js', 'src/c.js']);
  assert.equal(groups.find((group) => group.id === second.id).edited, true);
  assert.equal(groups.some((group) => group.id === first.id), false);
  assert.deepEqual(store.dialog.selected, []);
});

test('moving files into a new group starts with an empty message', () => {
  const plan = openDialog(sampleGroups());
  const docs = plan.groups[2];
  toggleSelected('README.md');
  moveSelected('new');
  const groups = store.dialog.plan.groups;
  assert.equal(groups.length, 3);
  const created = groups.find((group) => group.id !== docs.id && group.files.includes('README.md'));
  assert.notEqual(created, undefined);
  assert.deepEqual(created.files, ['README.md']);
  assert.equal(created.message, '');
  assert.equal(created.type, 'docs');
  assert.equal(created.edited, true);
  // The emptied rule group is gone.
  assert.equal(groups.some((group) => group.id === docs.id), false);
});

test('dropping files onto their own group changes nothing', () => {
  const plan = openDialog(sampleGroups());
  const first = plan.groups[0];
  moveFiles(['api/a.js'], first.id);
  assert.equal(store.dialog.plan.groups.length, 3);
  assert.deepEqual(store.dialog.plan.groups[0].files, ['api/a.js', 'api/b.js']);
  assert.equal(store.dialog.plan.groups[0].edited, false);
});

test('a group that loses files is marked as edited too', () => {
  const plan = openDialog(sampleGroups());
  const first = plan.groups[0];
  moveFiles(['api/a.js'], plan.groups[1].id);
  const groups = store.dialog.plan.groups;
  const source = groups.find((group) => group.id === first.id);
  assert.deepEqual(source.files, ['api/b.js']);
  assert.equal(source.edited, true);
  assert.equal(groups.find((group) => group.id === plan.groups[1].id).edited, true);
});

test('merging up keeps the target message and removes the source group', () => {
  const plan = openDialog(sampleGroups());
  const [first, second] = plan.groups;
  mergeUp(second.id);
  const groups = store.dialog.plan.groups;
  assert.equal(groups.length, 2);
  const merged = groups.find((group) => group.id === first.id);
  assert.deepEqual(merged.files, ['api/a.js', 'api/b.js', 'src/c.js']);
  assert.equal(merged.message, 'feat(api): 新增接口');
  assert.equal(merged.edited, true);
  assert.equal(groups.some((group) => group.id === second.id), false);
});

test('merging into a group with no message adopts the merged message', () => {
  const groups = sampleGroups();
  groups[0].message = '';
  groups[0].suggestion = 'feat(api): 新增接口';
  const plan = openDialog(groups);
  mergeUp(plan.groups[1].id);
  const merged = store.dialog.plan.groups[0];
  assert.equal(merged.message, 'refactor(src): 整理模块');
  assert.equal(merged.suggestion, 'feat(api): 新增接口');
});

test('expanding and collapsing a group is independent of the plan', () => {
  const plan = openDialog(sampleGroups());
  const id = plan.groups[0].id;
  toggleExpanded(id);
  assert.deepEqual(store.dialog.expanded, [id]);
  toggleExpanded(id);
  assert.deepEqual(store.dialog.expanded, []);
});

test('regrouping clears stale validation and keeps the rest of the plan', () => {
  const plan = openDialog(sampleGroups());
  store.dialog.messageErrors = [{ index: 0, reason: '旧错误' }];
  store.dialog.error = '旧错误';
  store.dialog.staged = ['legacy.js'];
  moveFiles(['api/a.js'], plan.groups[1].id);
  assert.deepEqual(store.dialog.messageErrors, []);
  assert.equal(store.dialog.error, '');
  assert.deepEqual(store.dialog.plan.staged, []);
  assert.equal(store.dialog.plan.branch, 'main');
});
