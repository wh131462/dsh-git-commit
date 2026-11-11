/**
 * Smart commit — Web Client entry.
 *
 * The dual-face build wraps this module in the `window.__ModuleLoader__`
 * registration. It exports the Cordis plugin shape (`inject` + `apply`), and
 * the module table supplies React and `react/jsx-runtime`.
 */

import type { ClientContext } from './context.js';
import { EN, ZH } from './i18n.js';
import { createStore } from './store.js';
import { createButton, createDialog, NS } from './ui.js';

export const inject: string[] = ['slots', 'locale'];

/** Client entry point; the slots are registered when the action context is ready. */
export function apply(ctx: ClientContext): void {
  const store = createStore();
  try {
    ctx.effect(() => ctx.locale?.register(NS, 'en', EN), 'smart-commit:locale-en');
    ctx.effect(() => ctx.locale?.register(NS, 'zh', ZH), 'smart-commit:locale-zh');
  } catch {
    /* locale is optional; the controls fall back to English copy */
  }
  ctx.inject(['slots'], (actionCtx) => {
    const slots = actionCtx.slots;
    if (slots === undefined) return;
    const Button = createButton(store, ctx);
    const Dialog = createDialog(store, ctx);
    slots.inject('conversation.input.left', () =>
      slots.register(
        { name: 'conversation.input.left', id: 'smart-commit', order: 0, locale: NS },
        Button,
      ),
    );
    slots.inject('shell.overlay', () =>
      slots.register(
        { name: 'shell.overlay', id: 'smart-commit-dialog', order: 50, locale: NS },
        Dialog,
      ),
    );
  });
}
