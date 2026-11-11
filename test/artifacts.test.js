import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * The published artifact is what users actually load. These checks run the
 * built host module and register the built client bundle with a fake module
 * table, so a bad build cannot pass the source-level tests unnoticed.
 */

const HOST = join(process.cwd(), 'lib', 'index.js');
const CLIENT = join(process.cwd(), 'lib', 'client.js');

function fakeRequire(name) {
  if (name === 'react') {
    return {
      createElement() {
        return null;
      },
      useState() {},
      useEffect() {},
      useRef() {},
    };
  }
  if (name === 'react/jsx-runtime') {
    return {
      Fragment: Symbol('Fragment'),
      jsx() {
        return null;
      },
      jsxs() {
        return null;
      },
    };
  }
  throw new Error(`unexpected client module: ${name}`);
}

test('built host exposes the Cordis plugin shape and registers its route', async () => {
  const plugin = await import(pathToFileURL(HOST).href);
  assert.equal(plugin.name, '@eternalheart/dsh-git-commit');
  assert.deepEqual(plugin.inject, []);
  assert.equal(typeof plugin.apply, 'function');

  const routes = [];
  const ctx = {
    inject(_deps, fn) {
      fn({
        effect(run) {
          run();
        },
        webServer: {
          register(options) {
            routes.push(options);
          },
        },
      });
    },
    effect() {},
    get() {
      return undefined;
    },
  };
  plugin.apply(ctx, { gitPath: 'git' });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/dsh-git-commit');
  assert.equal(typeof routes[0].handler, 'function');
});

test('built client registers itself once and keeps React external', async () => {
  const source = await readFile(CLIENT, 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/);
  assert.match(source, /require\("react"\)/);
  assert.match(source, /require\("react\/jsx-runtime"\)/);

  let registered;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registered = entry;
      },
    },
  };
  await import(`${pathToFileURL(CLIENT).href}?t=${Date.now()}`);
  assert.ok(registered !== undefined);
  assert.equal(registered.id, '@eternalheart/dsh-git-commit');
  assert.equal(typeof registered.factory, 'function');

  const plugin = registered.factory(fakeRequire);
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  assert.equal(typeof plugin.apply, 'function');

  const locales = [];
  const slots = [];
  plugin.apply({
    effect(run) {
      run();
    },
    inject(_deps, fn) {
      fn({
        slots: {
          inject(_slot, run) {
            run();
          },
          register(options) {
            slots.push(options);
          },
        },
      });
    },
    locale: {
      register(namespace, language) {
        locales.push(`${namespace}/${language}`);
      },
    },
  });
  assert.deepEqual(locales, ['dsh-smart-commit/en', 'dsh-smart-commit/zh']);
  assert.deepEqual(
    slots.map((slot) => slot.name),
    ['conversation.input.left', 'shell.overlay'],
  );
});

test('built client components render with the real React runtime', async () => {
  let registered;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registered = entry;
      },
    },
  };
  await import(`${pathToFileURL(CLIENT).href}?render=${Date.now()}`);
  assert.ok(registered !== undefined);

  const React = await import('react');
  const jsxRuntime = await import('react/jsx-runtime');
  const plugin = registered.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`unexpected client module: ${name}`);
  });

  let button;
  let dialog;
  plugin.apply({
    effect(run) {
      run();
    },
    inject(_deps, fn) {
      fn({
        slots: {
          inject(_slot, run) {
            run();
          },
          register(options, component) {
            if (options.name === 'conversation.input.left') button = component;
            else dialog = component;
          },
        },
      });
    },
    locale: {
      register() {},
      getLocale: () => 'zh',
    },
  });

  const { renderToStaticMarkup } = await import('react-dom/server');
  assert.ok(button !== undefined);
  assert.ok(dialog !== undefined);
  const html = renderToStaticMarkup(React.createElement(button, { sessionId: 'session-1' }));
  assert.match(html, /提交/);
  assert.equal(renderToStaticMarkup(React.createElement(dialog, {})), '');
});
