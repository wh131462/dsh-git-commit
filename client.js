/**
 * Smart commit — Web Client half.
 *
 * The click never sends a chat message. It executes the `/smart-commit` Host
 * command, which analyzes the working tree, names the groups with one model
 * call, and returns the plan as text. This module parses that text, opens a
 * confirmation dialog with one editable message per group, and sends the
 * edited messages back with `/smart-commit commit`.
 */
window.__ModuleLoader__.load({
  id: '@eternalheart/dsh-git-commit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-smart-commit';
    const COMMAND = '/smart-commit';
    const TIMEOUT_MS = 120000;

    const EN = {
      'action.label': 'Commit',
      'action.busy': 'Working\u2026',
      'action.failed': 'Failed',
      'action.title': 'Group the working-tree changes and name them with the current model.',
      'action.clean': 'Nothing to commit.',
      'action.cleanShort': 'Clean',
      'action.noSession': 'Open a session first.',
      'dialog.title': 'Confirm commit',
      'dialog.hint': 'Messages are editable; the host validates them before committing.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Commit',
      'dialog.committing': 'Committing\u2026',
      'dialog.done': 'Result',
      'dialog.close': 'Close',
      'dialog.retry': 'Analyze again',
      'dialog.regenerate': 'Regenerate messages',
      'dialog.files': '{n} files',
      'dialog.more': '+{n} more',
      'dialog.closeLabel': 'Close dialog',
    };
    const ZH = {
      'action.label': '提交',
      'action.busy': '处理中\u2026',
      'action.failed': '失败',
      'action.title': '按 Angular 规范分组，并用当前模型为每组生成 message。',
      'action.clean': '没有可提交的改动。',
      'action.cleanShort': '无改动',
      'action.noSession': '先打开一个会话。',
      'dialog.title': '确认提交',
      'dialog.hint': 'message 可以直接改，提交前由 Host 校验。',
      'dialog.cancel': '取消',
      'dialog.confirm': '确认提交',
      'dialog.committing': '提交中\u2026',
      'dialog.done': '提交结果',
      'dialog.close': '关闭',
      'dialog.retry': '重新分析',
      'dialog.regenerate': '重新生成 message',
      'dialog.files': '{n} 个文件',
      'dialog.more': '等 {n} 个',
      'dialog.closeLabel': '关闭弹窗',
    };
    const FALLBACK = EN;

    /** Page-level store shared by the button and the overlay dialog. */
    const store = {
      dialog: null,
      notices: new Map(),
      listeners: new Set(),
      inFlight: new Set(),
    };

    function emit() {
      for (const listener of store.listeners) listener();
    }

    function useStore(selector, deps) {
      const [value, setValue] = React.useState(selector);
      React.useEffect(() => {
        const listener = () => setValue(selector());
        store.listeners.add(listener);
        listener();
        return () => {
          store.listeners.delete(listener);
        };
      }, deps);
      return value;
    }

    function translator(ctx, props) {
      if (typeof props?.t === 'function') return props.t;
      let id = '';
      try {
        const snapshot = ctx.locale?.getLocale?.();
        id = typeof snapshot === 'string' ? snapshot : (snapshot?.id ?? snapshot?.locale ?? '');
      } catch {
        /* fall back to English */
      }
      const table = String(id).toLowerCase().startsWith('zh') ? ZH : EN;
      return (key) => table[key] ?? FALLBACK[key] ?? key;
    }

    function setNotice(sessionId, kind, text, ttl = 6000) {
      if (text === '') {
        store.notices.delete(sessionId);
      } else {
        store.notices.set(sessionId, { kind, text });
        if (ttl > 0) {
          setTimeout(() => {
            const current = store.notices.get(sessionId);
            if (current !== undefined && current.text === text) {
              store.notices.delete(sessionId);
              emit();
            }
          }, ttl);
        }
      }
      emit();
    }

    /** Parse the Host plan text back into editable groups. */
    function parsePlan(text) {
      const groups = [];
      const warnings = [];
      const staged = [];
      let summary = '';
      let note = '';
      for (const line of String(text).split('\n')) {
        const group = /^(\d+)\.\s+(.+?)\s+·\s+(\d+)\s+个文件\s*$/u.exec(line.trim());
        if (group !== null) {
          const message = group[2] === '（待补充 message）' ? '' : group[2];
          groups.push({ message, count: Number(group[3]), paths: [] });
          continue;
        }
        const path = /^\s+-\s+(.+)$/u.exec(line);
        if (path !== null && groups.length > 0) {
          groups[groups.length - 1].paths.push(path[1]);
          continue;
        }
        const stagedPath = /^\s+!\s+(.+)$/u.exec(line);
        if (stagedPath !== null) {
          staged.push(stagedPath[1]);
          continue;
        }
        if (line.startsWith('⚠')) {
          if (line.includes('暂存区已有')) continue;
          warnings.push(line.replace(/^⚠\s*/u, ''));
          continue;
        }
        if (line.includes('生成了全部') && line.includes('message')) {
          note = line.trim();
          continue;
        }
        if (summary === '' && line.trim() !== '') summary = line.trim();
      }
      if (groups.length === 0) return null;
      return { summary, note, groups, warnings, staged };
    }

    async function execute(ctx, sessionId, line) {
      let expire = null;
      const timeout = new Promise((_, reject) => {
        expire = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
      });
      let outcome;
      try {
        outcome = await Promise.race([ctx.remote.commands.execute(sessionId, line, []), timeout]);
      } finally {
        if (expire !== null) clearTimeout(expire);
      }
      if (outcome !== undefined && outcome !== null && outcome.ok === false) {
        throw new Error(outcome.error?.message ?? 'command rejected');
      }
      const result = outcome?.value?.result;
      if (result === undefined) throw new Error('command not registered');
      if (result.kind === 'error') throw new Error(result.text);
      return result.text ?? '';
    }

    async function analyze(ctx, sessionId, tr) {
      if (store.inFlight.has(sessionId)) return;
      store.inFlight.add(sessionId);
      setNotice(sessionId, '', '', 0);
      emit();
      try {
        const text = await execute(ctx, sessionId, COMMAND);
        const plan = parsePlan(text);
        if (plan === null) {
          setNotice(sessionId, 'ok', tr('action.clean'));
          return;
        }
        store.dialog = { sessionId, plan, phase: 'edit', error: '', result: '', unstage: false };
      } catch (error) {
        setNotice(sessionId, 'error', String(error instanceof Error ? error.message : error), 8000);
      } finally {
        store.inFlight.delete(sessionId);
        emit();
      }
    }

    function closeDialog() {
      store.dialog = null;
      emit();
    }

    /** The Host consumes the plan before committing, so close-once semantics. */
    async function commit(ctx, tr) {
      const dialog = store.dialog;
      if (dialog === null || dialog.phase === 'committing') return;
      store.dialog = { ...dialog, phase: 'committing', error: '' };
      emit();
      try {
        const json = JSON.stringify({
          messages: dialog.plan.groups.map((group) => group.message),
          unstage: dialog.unstage === true,
        });
        const bytes = new TextEncoder().encode(json);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        // Base64 keeps any quote or newline out of the command line.
        const text = await execute(ctx, dialog.sessionId, `${COMMAND} commit ${btoa(binary)}`);
        store.dialog = { ...dialog, phase: 'done', result: text };
      } catch (error) {
        store.dialog = {
          ...dialog,
          phase: 'error',
          error: String(error instanceof Error ? error.message : error),
        };
      } finally {
        emit();
      }
    }

    async function retry(ctx, sessionId, tr) {
      closeDialog();
      await analyze(ctx, sessionId, tr);
    }

    const CSS = [
      // Button.
      '.dsh-sc-btn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease;}',
      '.dsh-sc-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dsh-sc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
      '.dsh-sc-btn[data-state="done"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dsh-sc-btn[data-state="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dsh-sc-btn[disabled]{cursor:progress;opacity:.7;}',
      '.dsh-sc-icon{display:inline-flex;align-items:center;}',
      // Overlay + dialog.
      '.dsh-sc-backdrop{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto;background:color-mix(in srgb, var(--dsw-alias-bg-base) 58%, transparent);}',
      '.dsh-sc-dialog{display:flex;flex-direction:column;width:min(700px,100%);max-height:min(82vh,760px);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);overflow:hidden;}',
      '.dsh-sc-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 10px;}',
      '.dsh-sc-head-text{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;}',
      '.dsh-sc-title{font-size:14px;font-weight:600;line-height:20px;}',
      '.dsh-sc-sub{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsh-sc-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1;cursor:pointer;}',
      '.dsh-sc-x:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dsh-sc-x:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
      '.dsh-sc-body{flex:1;min-height:0;overflow:auto;padding:2px 18px 8px;}',
      '.dsh-sc-row{display:flex;align-items:flex-start;gap:8px;padding:6px 0;}',
      '.dsh-sc-idx{width:18px;flex:none;padding-top:5px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;}',
      '.dsh-sc-field{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.dsh-sc-input{width:100%;box-sizing:border-box;min-height:28px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;resize:none;overflow:hidden;}',
      '.dsh-sc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
      '.dsh-sc-input:disabled{opacity:.7;}',
      '.dsh-sc-meta{display:flex;align-items:center;gap:8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-sc-paths{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsh-sc-count{flex:none;}',
      '.dsh-sc-warn{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px;}',
      '.dsh-sc-warn-paths{margin-top:4px;max-height:84px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:inherit;opacity:.9;}',
      '.dsh-sc-check{display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;}',
      '.dsh-sc-pre{margin:6px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;}',
      '.dsh-sc-error{color:var(--dsw-alias-state-error-primary);}',
      '.dsh-sc-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-sc-foot-hint{margin-right:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-sc-primary,.dsh-sc-ghost{height:28px;padding:0 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font:inherit;font-size:12px;cursor:pointer;flex:none;}',
      '.dsh-sc-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}',
      '.dsh-sc-primary:disabled{opacity:.6;cursor:progress;}',
      '.dsh-sc-ghost{background:transparent;color:var(--dsw-alias-label-secondary);}',
      '.dsh-sc-ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dsh-sc-ghost:disabled{opacity:.6;cursor:progress;}',
      '.dsh-sc-primary:focus-visible,.dsh-sc-ghost:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '@media (prefers-reduced-motion: reduce){.dsh-sc-btn{transition:none!important;}}',
    ].join('\n');

    /** A commit node on the current branch, with a sparkle for the smart naming. */
    function CommitIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M6.2 1.9v2.8M6.2 11.3v2.8',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 6.2, cy: 8, r: 2.55, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('circle', { cx: 6.2, cy: 8, r: 0.95, fill: 'currentColor' }),
        h('path', {
          d: 'M12.4 1.9c.22 2.3.8 2.88 3.1 3.1-2.3.22-2.88.8-3.1 3.1-.22-2.3-.8-2.88-3.1-3.1 2.3-.22 2.88-.8 3.1-3.1Z',
          fill: 'currentColor',
        }),
      );
    }

    function createButton(ctx, localeCtx) {
      return function SmartCommitButton(props) {
        const { sessionId: sessionIdProp, useSession: useSessionHook } = props;
        const tr = translator(localeCtx, props);
        const stored =
          typeof useSessionHook === 'function' ? useSessionHook((snapshot) => snapshot?.sessionId) : undefined;
        const sessionId =
          typeof sessionIdProp === 'string' && sessionIdProp !== '' ? sessionIdProp : stored;

        const state = useStore(() => {
          const dialog = store.dialog;
          return {
            busy: store.inFlight.has(sessionId),
            openHere: dialog !== null && dialog.sessionId === sessionId,
            notice: store.notices.get(sessionId) ?? null,
          };
        }, [sessionId]);

        const noSession = typeof sessionId !== 'string' || sessionId === '';
        const failure = state.notice !== null && state.notice.kind === 'error';
        const done = state.notice !== null && state.notice.kind === 'ok';
        const look = state.busy
          ? 'busy'
          : state.openHere
            ? 'plan'
            : failure
              ? 'error'
              : done
                ? 'done'
                : 'idle';
        const label = state.busy
          ? tr('action.busy')
          : state.openHere
            ? tr('dialog.title')
            : failure
              ? tr('action.failed')
              : done
                ? tr('action.cleanShort')
                : tr('action.label');
        const title =
          failure && state.notice !== null
            ? `${tr('action.failed')}: ${state.notice.text}`
            : state.openHere
              ? tr('action.title')
              : done && state.notice !== null
                ? state.notice.text
                : tr('action.title');

        const run = () => {
          if (noSession || state.openHere) return;
          analyze(ctx, sessionId, tr);
        };

        return h('div', { className: 'dsh-sc-root' }, [
          h('style', { key: 'dsh-sc-css' }, CSS),
          h(
            'button',
            {
              key: 'dsh-sc-button',
              type: 'button',
              className: 'dsh-sc-btn',
              'data-state': look,
              title: noSession ? tr('action.noSession') : title,
              'aria-label': title,
              disabled: state.busy || noSession,
              onClick: run,
            },
            [
              h('span', { key: 'icon', className: 'dsh-sc-icon' }, h(CommitIcon)),
              h('span', { key: 'label', className: 'dsh-sc-label' }, label),
            ],
          ),
        ]);
      };
    }

    function createDialog(ctx, localeCtx) {
      return function SmartCommitDialog(props) {
        const tr = translator(localeCtx, props);
        const dialog = useStore(() => store.dialog, []);
        const confirmRef = React.useRef(null);
        const dialogRef = React.useRef(null);
        const phaseRef = React.useRef('edit');
        phaseRef.current = dialog?.phase ?? 'edit';

        const close = () => {
          if (phaseRef.current === 'committing') return;
          closeDialog();
        };

        React.useEffect(() => {
          if (dialog === null) return undefined;
          const previous = document.activeElement;
          const onKey = (event) => {
            if (event.key === 'Escape' && phaseRef.current !== 'committing') {
              event.stopPropagation();
              closeDialog();
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
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [dialog === null]);

        if (dialog === null) return null;

        const { plan, phase } = dialog;
        const committing = phase === 'committing';
        const locked = committing;

        const update = (index, value) => {
          const next = {
            ...plan,
            groups: plan.groups.map((group, position) =>
              position === index ? { ...group, message: value } : group,
            ),
          };
          store.dialog = { ...dialog, plan: next };
          emit();
        };

        const missing = plan.groups.filter((group) => group.message.trim() === '').length;
        const head = h('div', { key: 'head', className: 'dsh-sc-head' }, [
          h('div', { key: 'text', className: 'dsh-sc-head-text' }, [
            h('div', { key: 'title', className: 'dsh-sc-title' }, tr('dialog.title')),
            h(
              'div',
              { key: 'sub', className: 'dsh-sc-sub', title: plan.summary },
              plan.summary,
            ),
          ]),
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dsh-sc-x',
              'aria-label': tr('dialog.closeLabel'),
              title: tr('dialog.close'),
              disabled: locked,
              onClick: close,
            },
            '\u00d7',
          ),
        ]);

        const footer = (() => {
          if (phase === 'committing') {
            return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
              h('span', { key: 'hint', className: 'dsh-sc-foot-hint' }, tr('dialog.committing')),
              h(
                'button',
                { key: 'cancel', type: 'button', className: 'dsh-sc-ghost', disabled: true },
                tr('dialog.cancel'),
              ),
              h(
                'button',
                { key: 'confirm', type: 'button', className: 'dsh-sc-primary', disabled: true },
                tr('dialog.committing'),
              ),
            ]);
          }
          if (phase === 'done') {
            return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
              h('span', { key: 'hint', className: 'dsh-sc-foot-hint' }, ''),
              h(
                'button',
                {
                  key: 'close',
                  type: 'button',
                  className: 'dsh-sc-primary',
                  onClick: closeDialog,
                },
                tr('dialog.close'),
              ),
            ]);
          }
          if (phase === 'error') {
            return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
              h('span', { key: 'hint', className: 'dsh-sc-foot-hint' }, ''),
              h(
                'button',
                {
                  key: 'retry',
                  type: 'button',
                  className: 'dsh-sc-ghost',
                  onClick: () => retry(ctx, dialog.sessionId, tr),
                },
                tr('dialog.retry'),
              ),
              h(
                'button',
                {
                  key: 'close',
                  type: 'button',
                  className: 'dsh-sc-primary',
                  onClick: closeDialog,
                },
                tr('dialog.close'),
              ),
            ]);
          }
          return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
            h(
              'span',
              { key: 'hint', className: 'dsh-sc-foot-hint', title: tr('dialog.hint') },
              missing > 0
                ? `还有 ${missing} 组没有 message，补写或点「重新生成」`
                : plan.staged.length > 0 && dialog.unstage !== true
                  ? '先勾选「先取消暂存」才能提交'
                  : tr('dialog.hint'),
            ),
            h(
              'button',
              {
                key: 'cancel',
                type: 'button',
                className: 'dsh-sc-ghost',
                onClick: close,
              },
              tr('dialog.cancel'),
            ),
            missing > 0
              ? h(
                  'button',
                  {
                    key: 'regenerate',
                    type: 'button',
                    className: 'dsh-sc-ghost',
                    onClick: () => retry(ctx, dialog.sessionId, tr),
                  },
                  tr('dialog.regenerate'),
                )
              : null,
            h(
              'button',
              {
                key: 'confirm',
                type: 'button',
                className: 'dsh-sc-primary',
                ref: confirmRef,
                disabled:
                  missing > 0 || (plan.staged.length > 0 && dialog.unstage !== true),
                onClick: () => commit(ctx, tr),
              },
              tr('dialog.confirm'),
            ),
          ]);
        })();

        let body;
        if (phase === 'done') {
          body = h('div', { key: 'body', className: 'dsh-sc-body' }, [
            h('div', { key: 'label', className: 'dsh-sc-title' }, tr('dialog.done')),
            h('pre', { key: 'result', className: 'dsh-sc-pre' }, dialog.result),
          ]);
        } else if (phase === 'error') {
          body = h('div', { key: 'body', className: 'dsh-sc-body' }, [
            h('div', { key: 'label', className: 'dsh-sc-title' }, tr('dialog.done')),
            h('pre', { key: 'result', className: 'dsh-sc-pre dsh-sc-error' }, dialog.error),
          ]);
        } else {
          body = h(
            'div',
            { key: 'body', className: 'dsh-sc-body' },
            [
              ...plan.groups.map((group, index) =>
                h('div', { key: `group-${index}`, className: 'dsh-sc-row' }, [
                  h('span', { key: 'idx', className: 'dsh-sc-idx' }, String(index + 1)),
                  h('div', { key: 'field', className: 'dsh-sc-field' }, [
                    h('textarea', {
                      key: 'input',
                      className: 'dsh-sc-input',
                      value: group.message,
                      rows: Math.max(1, group.message.split('\n').length),
                      spellCheck: false,
                      disabled: locked,
                      placeholder: '模型未给出，请补写一条语义 message',
                      'aria-label': `commit message ${index + 1}`,
                      onChange: (event) => {
                        update(index, event.target.value);
                        event.target.style.height = 'auto';
                        event.target.style.height = `${event.target.scrollHeight}px`;
                      },
                    }),
                    h('div', { key: 'meta', className: 'dsh-sc-meta' }, [
                      h(
                        'span',
                        {
                          key: 'paths',
                          className: 'dsh-sc-paths',
                          title: group.paths.join('\n'),
                        },
                        group.paths.length > 3
                          ? `${group.paths.slice(0, 3).join('、')} ${tr('dialog.more').replace('{n}', String(group.paths.length - 3))}`
                          : group.paths.join('、'),
                      ),
                      h(
                        'span',
                        { key: 'count', className: 'dsh-sc-count' },
                        tr('dialog.files').replace('{n}', String(group.count)),
                      ),
                    ]),
                  ]),
                ]),
              ),
              plan.staged.length > 0
                ? h('div', { key: 'staged', className: 'dsh-sc-warn' }, [
                    h(
                      'div',
                      { key: 'text' },
                      `暂存区已有 ${plan.staged.length} 个文件，提交前需要先取消暂存（改动保留在工作区）：`,
                    ),
                    h(
                      'div',
                      { key: 'paths', className: 'dsh-sc-warn-paths' },
                      plan.staged.join('\n'),
                    ),
                    h(
                      'label',
                      { key: 'toggle', className: 'dsh-sc-check' },
                      [
                        h('input', {
                          key: 'box',
                          type: 'checkbox',
                          checked: dialog.unstage === true,
                          disabled: locked,
                          onChange: () => {
                            store.dialog = { ...dialog, unstage: dialog.unstage !== true };
                            emit();
                          },
                        }),
                        h('span', { key: 'label' }, '先取消这些文件的暂存'),
                      ],
                    ),
                  ])
                : null,
              plan.warnings.length > 0
                ? h('div', { key: 'warn', className: 'dsh-sc-warn' }, plan.warnings.join('；'))
                : null,
              plan.note !== ''
                ? h('div', { key: 'note', className: 'dsh-sc-meta', style: { marginTop: '8px' } }, plan.note)
                : null,
            ],
          );
        }

        return h(
          'div',
          {
            className: 'dsh-sc-backdrop',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) close();
            },
          },
          h(
            'div',
            {
              className: 'dsh-sc-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': tr('dialog.title'),
              tabIndex: -1,
              ref: dialogRef,
              onMouseDown: (event) => event.stopPropagation(),
            },
            [h('style', { key: 'dsh-sc-css' }, CSS), head, body, footer],
          ),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'smart-commit:locale-en');
          ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'smart-commit:locale-zh');
        } catch {
          /* locale is optional; the controls fall back to English copy */
        }
        // `remote` itself is required to touch `ctx.remote`; the dotted entry
        // only makes that namespace's methods known to the dependency check.
        ctx.inject(['slots', 'remote', 'remote.commands', 'sessions'], (actionCtx) => {
          const Button = createButton(actionCtx, ctx);
          const Dialog = createDialog(actionCtx, ctx);
          actionCtx.slots.inject('conversation.input.left', () =>
            actionCtx.slots.register(
              { name: 'conversation.input.left', id: 'smart-commit', order: 0, locale: NS },
              Button,
            ),
          );
          actionCtx.slots.inject('shell.overlay', () =>
            actionCtx.slots.register(
              { name: 'shell.overlay', id: 'smart-commit-dialog', order: 50, locale: NS },
              Dialog,
            ),
          );
        });
      },
    };
  },
});
