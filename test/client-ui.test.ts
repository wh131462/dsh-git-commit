import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ClientContext } from '../src/client/context.js';
import { createStore, preparePlan } from '../src/client/store.js';
import { createButton, createDialog } from '../src/client/ui.js';

/**
 * Render the real components on the server. This catches broken JSX, missing
 * props, and hook-order mistakes without a browser or the DSH shell.
 */

function context(): ClientContext {
  return {
    effect() {},
    inject() {},
    locale: {
      register() {},
      getLocale: () => 'zh',
    },
  };
}

const tr = (key: string): string => key;

function editStore() {
  const store = createStore();
  store.dialog = {
    requestId: 1,
    sessionId: 'session-1',
    controller: new AbortController(),
    phase: 'edit',
    plan: preparePlan({
      vcs: 'git',
      branch: 'main',
      hasHead: true,
      staged: [],
      skipped: [],
      warnings: [],
      untracked: [],
      added: [],
      groups: [
        {
          type: 'feat',
          scope: 'api',
          message: 'feat(api): 新增接口',
          suggestion: 'feat(api): 新增接口',
          files: ['api/a.js', 'api/b.js'],
        },
      ],
    }),
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
  return store;
}

test('the button renders its idle label', () => {
  const Button = createButton(createStore(), context());
  const html = renderToStaticMarkup(createElement(Button, { sessionId: 'session-1', t: tr }));
  assert.match(html, /action\.label/);
  assert.match(html, /dsh-sc-btn/);
});

test('the edit dialog renders groups, files, and the confirm button', () => {
  const Dialog = createDialog(editStore(), context());
  const html = renderToStaticMarkup(createElement(Dialog, { t: tr }));
  assert.match(html, /dialog\.title/);
  assert.match(html, /feat\(api\): 新增接口/);
  assert.match(html, /api\/a\.js/);
  assert.match(html, /dialog\.confirm/);
});

test('the analyzing, done, and closed states render without a plan', () => {
  const closedStore = createStore();
  const ClosedDialog = createDialog(closedStore, context());
  assert.equal(renderToStaticMarkup(createElement(ClosedDialog, { t: tr })), '');

  const store = editStore();
  const Dialog = createDialog(store, context());
  const dialog = store.dialog;
  assert.ok(dialog !== null);
  store.dialog = { ...dialog, phase: 'analyzing', plan: null };
  const analyzing = renderToStaticMarkup(createElement(Dialog, { t: tr }));
  assert.match(analyzing, /dialog\.analyzing/);

  store.dialog = { ...dialog, phase: 'done', ok: true, result: '提交完成：1 组。' };
  const done = renderToStaticMarkup(createElement(Dialog, { t: tr }));
  assert.match(done, /提交完成：1 组。/);
});
