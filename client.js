/**
 * Smart commit — Web Client half.
 *
 * The button calls the Host's JSON channel directly (`analyze` → `name` →
 * `commit`). The dialog opens before the slow model call starts, so every
 * phase has a visible label; no command row is written to the conversation and
 * no message payload travels as base64.
 *
 * @module dsh-git-commit/client
 */
window.__ModuleLoader__.load({
  id: '@eternalheart/dsh-git-commit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-smart-commit';
    const API = 'dsh-git-commit';
    const ANALYZE_TIMEOUT_MS = 60000;
    const NAME_TIMEOUT_MS = 180000;
    const COMMIT_TIMEOUT_MS = 180000;

    const EN = {
      'action.label': 'Commit',
      'action.busy': 'Working\u2026',
      'action.open': 'Confirming',
      'action.failed': 'Failed',
      'action.cleanShort': 'Clean',
      'action.noSession': 'Open a session first.',
      'action.title': 'Group the working-tree changes and name them with the current model.',
      'dialog.title': 'Confirm commit',
      'dialog.hint': 'Messages are editable; the host validates them before committing.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Commit',
      'dialog.committing': 'Committing\u2026',
      'dialog.analyzing': 'Reading the working tree\u2026',
      'dialog.naming': 'Naming {n} groups with {model}\u2026',
      'dialog.manual': 'The model did not name every group. Write the missing messages by hand.',
      'dialog.done': 'Result',
      'dialog.close': 'Close',
      'dialog.reanalyze': 'Analyze again',
      'dialog.regenerate': 'Regenerate messages',
      'dialog.files': '{n} files',
      'dialog.more': '+{n} more',
      'dialog.closeLabel': 'Close dialog',
      'dialog.svnNote':
        'SVN working copy: commits use explicit paths, one revision per group. There is no staging area.',
      'dialog.summary': '{groups} groups / {files} files \u00b7 {branch} \u00b7 {vcs}',
      'dialog.missing': '{n} groups still need a message.',
      'dialog.needUnstage': 'Tick the unstage box before committing.',
      'dialog.modelMissing': 'The model did not name this group: {reason}',
      'dialog.invalid': 'Not valid yet: {reason}',
      'dialog.placeholder': 'Write a commit message',
      'dialog.modelFailed': 'Message generation failed: {reason}. Write messages by hand or try again.',
      'dialog.skipped': 'Skipped {n} sensitive files: {paths}',
      'dialog.staged': 'The index already holds {n} files. Release them first:',
      'dialog.stagedBox': 'Release these files from the index',
    };
    const ZH = {
      'action.label': '提交',
      'action.busy': '处理中\u2026',
      'action.open': '确认中',
      'action.failed': '失败',
      'action.cleanShort': '无改动',
      'action.noSession': '先打开一个会话。',
      'action.title': '按 Angular 规范分组，并用当前模型为每组生成 message。',
      'dialog.title': '确认提交',
      'dialog.hint': 'message 可以直接改，提交前由 Host 校验。',
      'dialog.cancel': '取消',
      'dialog.confirm': '确认提交',
      'dialog.committing': '提交中\u2026',
      'dialog.analyzing': '正在读取工作区\u2026',
      'dialog.naming': '正在用 {model} 生成 {n} 条 message\u2026',
      'dialog.manual': '模型没有为每一组生成 message，缺失的可以手动补写。',
      'dialog.done': '提交结果',
      'dialog.close': '关闭',
      'dialog.reanalyze': '重新分析',
      'dialog.regenerate': '重新生成 message',
      'dialog.files': '{n} 个文件',
      'dialog.more': '等 {n} 个',
      'dialog.closeLabel': '关闭弹窗',
      'dialog.svnNote': 'SVN 工作副本：按路径提交，每组一个 revision；没有暂存区。',
      'dialog.summary': '{groups} 组 / {files} 个文件 \u00b7 {branch} \u00b7 {vcs}',
      'dialog.missing': '还有 {n} 组没有 message。',
      'dialog.needUnstage': '先勾选「先取消暂存」才能提交。',
      'dialog.modelMissing': '这一组没有生成 message：{reason}',
      'dialog.invalid': '还不合规：{reason}',
      'dialog.placeholder': '写一条 commit message',
      'dialog.modelFailed': '生成 message 失败：{reason}。可以手动补写，或再试一次。',
      'dialog.skipped': '已跳过 {n} 个敏感文件：{paths}',
      'dialog.staged': '暂存区已有 {n} 个文件，提交前需要先取消暂存：',
      'dialog.stagedBox': '先取消这些文件的暂存',
    };
    const FALLBACK = EN;

    /** Page-level store shared by the button and the overlay dialog. */
    const store = {
      dialog: null,
      notices: new Map(),
      listeners: new Set(),
      starting: new Set(),
      seq: 0,
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

    /** One Host failure with the code and details the API sent back. */
    class ApiError extends Error {
      constructor(code, message, details) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.details = details;
      }
    }

    /** AbortSignal.any with a fallback for older page runtimes. */
    function anySignal(signals) {
      const list = signals.filter((signal) => signal !== undefined && signal !== null);
      if (list.length === 1) return list[0];
      if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
      const controller = new AbortController();
      for (const signal of list) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
      return controller.signal;
    }

    function endpointUrl(endpoint) {
      // The channel lives at the server root, independent of the SPA route.
      const origin =
        typeof location === 'undefined' || typeof location.origin !== 'string'
          ? 'http://localhost'
          : location.origin;
      return `${origin}/${API}/${endpoint}`;
    }

    /**
     * POST one JSON request to the Host channel and unwrap its envelope.
     * @param endpoint - `analyze`, `name`, or `commit`.
     * @param payload - JSON request body.
     * @param options - dialog signal and deadline.
     * @returns the `value` of a successful envelope.
     */
    async function call(endpoint, payload, { signal, timeoutMs } = {}) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error('timeout')), timeoutMs ?? 60000);
      const composite = anySignal([signal, timeout.signal]);
      try {
        let response;
        try {
          response = await fetch(endpointUrl(endpoint), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
            credentials: 'same-origin',
            cache: 'no-store',
            signal: composite,
          });
        } catch (error) {
          if (signal?.aborted === true) throw error;
          if (timeout.signal.aborted) {
            throw new ApiError('timeout', `请求超时（${Math.round((timeoutMs ?? 60000) / 1000)} 秒）。`);
          }
          throw new ApiError('network', '连不上 DSH 的本地服务，确认应用仍在运行。');
        }
        // 404/405 means no route is registered: an older Host still serves the
        // SPA fallback here. Say how to fix it instead of reporting a raw HTTP code.
        if (response.status === 404 || response.status === 405) {
          throw new ApiError('no-host', 'Host 端没有加载新版插件，重启 DSH 后再试。');
        }
        if (!response.ok) {
          throw new ApiError('http', `插件请求失败（HTTP ${response.status}）。`);
        }
        // An older Host (or the SPA fallback) answers with HTML; say what to do
        // instead of reporting a JSON parse failure.
        if (!String(response.headers.get('content-type') ?? '').includes('application/json')) {
          throw new ApiError('no-host', 'Host 端没有加载新版插件，重启 DSH 后再试。');
        }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ApiError('bad-response', '插件返回的不是 JSON。');
        }
        if (body?.ok !== true) {
          throw new ApiError(
            body?.error?.code ?? 'failed',
            body?.error?.message ?? '插件返回了未知错误。',
            body?.error?.details,
          );
        }
        return body.value;
      } finally {
        clearTimeout(timer);
      }
    }

    function isCurrent(requestId) {
      return store.dialog !== null && store.dialog.requestId === requestId;
    }

    function closeDialog() {
      const dialog = store.dialog;
      if (dialog !== null && typeof dialog.controller?.abort === 'function') {
        dialog.controller.abort();
      }
      store.dialog = null;
      emit();
    }

    /** Analyze, then name; the dialog is on screen from the first phase. */
    async function start(sessionId, tr) {
      if (typeof sessionId !== 'string' || sessionId === '') {
        setNotice('', 'error', tr('action.noSession'), 0);
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
      if (store.dialog !== null) closeDialog();

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
      };
      emit();

      try {
        let analyzed;
        try {
          analyzed = await call(
            'analyze',
            { sessionId },
            { signal: controller.signal, timeoutMs: ANALYZE_TIMEOUT_MS },
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          store.dialog = null;
          setNotice(sessionId, error.code === 'clean' ? 'ok' : 'error', error.message, 9000);
          return;
        }
        if (!isCurrent(requestId)) return;

        store.dialog = {
          ...store.dialog,
          phase: analyzed.useModel ? 'naming' : 'edit',
          plan: analyzed.plan,
          useModel: analyzed.useModel === true,
          model: analyzed.model,
          note: analyzed.useModel ? '' : tr('dialog.manual'),
        };
        emit();

        if (!analyzed.useModel) return;
        try {
          const named = await call('name', { sessionId }, { signal: controller.signal, timeoutMs: NAME_TIMEOUT_MS });
          if (!isCurrent(requestId)) return;
          store.dialog = {
            ...store.dialog,
            phase: 'edit',
            plan: named.plan,
            model: named.model,
            note: named.note,
            failures: Array.isArray(named.failures) ? named.failures : [],
          };
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!isCurrent(requestId)) return;
          store.dialog = {
            ...store.dialog,
            phase: 'edit',
            error: tr('dialog.modelFailed').replace('{reason}', error.message),
          };
        }
      } finally {
        store.starting.delete(sessionId);
        emit();
      }
    }

    /** Re-run only the model step, keeping the dialog's request id. */
    async function regenerate(tr) {
      const dialog = store.dialog;
      if (dialog === null || dialog.phase !== 'edit' || dialog.useModel !== true) return;
      const { requestId, sessionId, controller } = dialog;
      store.dialog = { ...dialog, phase: 'naming', error: '', stale: false, failures: [], messageErrors: [] };
      emit();
      try {
        const named = await call('name', { sessionId }, { signal: controller.signal, timeoutMs: NAME_TIMEOUT_MS });
        if (!isCurrent(requestId)) return;
        store.dialog = {
          ...store.dialog,
          phase: 'edit',
          plan: named.plan,
          model: named.model,
          note: named.note,
          stale: false,
          failures: Array.isArray(named.failures) ? named.failures : [],
          messageErrors: [],
        };
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!isCurrent(requestId)) return;
        store.dialog = {
          ...store.dialog,
          phase: 'edit',
          error: tr('dialog.modelFailed').replace('{reason}', error.message),
        };
      } finally {
        emit();
      }
    }

    function restart(tr) {
      const dialog = store.dialog;
      if (dialog === null) return;
      const sessionId = dialog.sessionId;
      closeDialog();
      start(sessionId, tr);
    }

    async function commit() {
      const dialog = store.dialog;
      if (dialog === null || dialog.phase !== 'edit') return;
      const messages = dialog.plan.groups.map((group) => group.message);
      if (messages.some((message) => message.trim() === '')) return;
      if (dialog.plan.staged.length > 0 && dialog.unstage !== true) return;

      store.dialog = { ...dialog, phase: 'committing', error: '', messageErrors: [] };
      emit();
      try {
        const result = await call(
          'commit',
          {
            sessionId: dialog.sessionId,
            plan: dialog.plan,
            messages,
            unstage: dialog.unstage === true,
          },
          { signal: dialog.controller.signal, timeoutMs: COMMIT_TIMEOUT_MS },
        );
        if (!isCurrent(dialog.requestId)) return;
        store.dialog = {
          ...store.dialog,
          phase: 'done',
          ok: result.ok === true,
          result: result.text ?? '',
        };
      } catch (error) {
        if (dialog.controller.signal.aborted) return;
        if (!isCurrent(dialog.requestId)) return;
        const groups =
          error.code === 'invalid-message' && Array.isArray(error.details?.groups)
            ? error.details.groups
            : [];
        const staged =
          error.code === 'staged' && Array.isArray(error.details?.paths)
            ? error.details.paths
            : null;
        store.dialog = {
          ...store.dialog,
          phase: 'edit',
          error: error.message,
          messageErrors: groups,
          stale: error.code === 'stale',
          ...(staged === null ? {} : { plan: { ...store.dialog.plan, staged } }),
        };
      } finally {
        emit();
      }
    }

    function updateMessage(index, value) {
      const dialog = store.dialog;
      if (dialog === null || dialog.phase !== 'edit') return;
      const plan = {
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
      emit();
    }

    function toggleUnstage() {
      const dialog = store.dialog;
      if (dialog === null || dialog.phase !== 'edit') return;
      store.dialog = { ...dialog, unstage: dialog.unstage !== true, error: '' };
      emit();
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
      // Spinner + progress.
      '.dsh-sc-spinner{width:11px;height:11px;flex:none;border:1.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dsh-sc-spin .75s linear infinite;}',
      '@keyframes dsh-sc-spin{to{transform:rotate(360deg);}}',
      '.dsh-sc-progress{display:flex;align-items:center;gap:8px;margin:2px 0 10px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;}',
      '.dsh-sc-progress-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
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
      '.dsh-sc-input:disabled{opacity:.72;cursor:progress;}',
      '.dsh-sc-input[data-loading="true"]{border-style:dashed;}',
      '.dsh-sc-meta{display:flex;align-items:center;gap:8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-sc-paths{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsh-sc-count{flex:none;}',
      '.dsh-sc-line{margin-top:1px;font-size:11px;line-height:15px;}',
      '.dsh-sc-line[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);}',
      '.dsh-sc-line[data-kind="error"]{color:var(--dsw-alias-state-error-primary);}',
      '.dsh-sc-warn{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px;}',
      '.dsh-sc-warn-paths{margin-top:4px;max-height:84px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:inherit;opacity:.9;}',
      '.dsh-sc-check{display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;}',
      '.dsh-sc-note{margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}',
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
      '.dsh-sc-skeleton{display:flex;flex-direction:column;gap:10px;padding:8px 0 4px;}',
      '.dsh-sc-skeleton-row{height:34px;border-radius:8px;background:linear-gradient(90deg, var(--dsw-alias-bg-layer-1), color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, var(--dsw-alias-bg-base)), var(--dsw-alias-bg-layer-1));background-size:200% 100%;animation:dsh-sc-shimmer 1.4s ease-in-out infinite;}',
      '@keyframes dsh-sc-shimmer{0%{background-position:0% 0;}100%{background-position:-200% 0;}}',
      '@media (prefers-reduced-motion: reduce){.dsh-sc-spinner{animation-duration:2.4s;}.dsh-sc-skeleton-row{animation:none;}}',
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

    /** The busy dot next to a phase label. */
    function Spinner() {
      return h('span', { className: 'dsh-sc-spinner', 'aria-hidden': 'true' });
    }

    /** One phase banner: spinner plus a sentence. */
    function Progress({ text }) {
      return h('div', { className: 'dsh-sc-progress', role: 'status', 'aria-live': 'polite' }, [
        h('span', { key: 'dot', className: 'dsh-sc-spinner', 'aria-hidden': 'true' }),
        h('span', { key: 'text', className: 'dsh-sc-progress-text' }, text),
      ]);
    }

    function skeleton() {
      return h(
        'div',
        { className: 'dsh-sc-skeleton', 'aria-hidden': 'true' },
        [0, 1, 2].map((index) => h('div', { key: index, className: 'dsh-sc-skeleton-row' })),
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
            starting: store.starting.has(sessionId),
            openHere: dialog !== null && dialog.sessionId === sessionId,
            notice: store.notices.get(sessionId) ?? null,
          };
        }, [sessionId]);

        const noSession = typeof sessionId !== 'string' || sessionId === '';
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
        const title = failure && state.notice !== null ? state.notice.text : tr('action.title');

        const run = () => {
          if (noSession) return;
          // An open dialog owns the button; a finished one can be replaced.
          if (state.openHere && store.dialog?.phase !== 'done') return;
          start(sessionId, tr);
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
              disabled: state.starting || noSession,
              onClick: run,
            },
            [
              h('span', { key: 'icon', className: 'dsh-sc-icon' }, state.starting ? Spinner() : h(CommitIcon)),
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
        const missing = plan === null ? 0 : plan.groups.filter((group) => group.message.trim() === '').length;
        const fileCount =
          plan === null ? 0 : plan.groups.reduce((sum, group) => sum + group.files.length, 0);

        const subtitle = (() => {
          if (phase === 'analyzing') return tr('dialog.analyzing');
          if (phase === 'naming' && plan !== null) {
            return tr('dialog.naming')
              .replace('{n}', String(plan.groups.length))
              .replace('{model}', dialog.model ?? '');
          }
          if (plan === null) return dialog.error;
          const branch =
            plan.vcs === 'svn' && plan.revision !== undefined ? `${plan.branch}@r${plan.revision}` : plan.branch;
          return tr('dialog.summary')
            .replace('{groups}', String(plan.groups.length))
            .replace('{files}', String(fileCount))
            .replace('{branch}', branch ?? '')
            .replace('{vcs}', String(plan.vcs).toUpperCase());
        })();

        const head = h('div', { key: 'head', className: 'dsh-sc-head' }, [
          h('div', { key: 'text', className: 'dsh-sc-head-text' }, [
            h('div', { key: 'title', className: 'dsh-sc-title' }, tr('dialog.title')),
            h('div', { key: 'sub', className: 'dsh-sc-sub', title: subtitle }, subtitle),
          ]),
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dsh-sc-x',
              'aria-label': tr('dialog.closeLabel'),
              title: tr('dialog.close'),
              disabled: phase === 'committing',
              onClick: close,
            },
            '\u00d7',
          ),
        ]);

        const footer = (() => {
          if (phase === 'committing') {
            return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
              h('span', { key: 'hint', className: 'dsh-sc-foot-hint' }, tr('dialog.committing')),
              h('button', { key: 'cancel', type: 'button', className: 'dsh-sc-ghost', disabled: true }, tr('dialog.cancel')),
              h('button', { key: 'confirm', type: 'button', className: 'dsh-sc-primary', disabled: true }, tr('dialog.committing')),
            ]);
          }
          if (phase === 'done') {
            return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
              h('span', { key: 'hint', className: 'dsh-sc-foot-hint' }, ''),
              dialog.ok
                ? null
                : h('button', { key: 'again', type: 'button', className: 'dsh-sc-ghost', onClick: () => restart(tr) }, tr('dialog.reanalyze')),
              h('button', { key: 'close', type: 'button', className: 'dsh-sc-primary', onClick: closeDialog }, tr('dialog.close')),
            ]);
          }
          if (phase === 'error') {
            return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
              h('span', { key: 'hint', className: 'dsh-sc-foot-hint' }, ''),
              h('button', { key: 'again', type: 'button', className: 'dsh-sc-ghost', onClick: () => restart(tr) }, tr('dialog.reanalyze')),
              h('button', { key: 'close', type: 'button', className: 'dsh-sc-primary', onClick: closeDialog }, tr('dialog.close')),
            ]);
          }
          if (phase === 'analyzing') {
            return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
              h('span', { key: 'hint', className: 'dsh-sc-foot-hint' }, tr('dialog.analyzing')),
              h('button', { key: 'cancel', type: 'button', className: 'dsh-sc-ghost', onClick: closeDialog }, tr('dialog.cancel')),
              h('button', { key: 'confirm', type: 'button', className: 'dsh-sc-primary', disabled: true }, tr('dialog.confirm')),
            ]);
          }

          // `naming` and `edit` share the same footer shape.
          const hint =
            phase === 'naming'
              ? tr('dialog.naming')
                  .replace('{n}', String(plan.groups.length))
                  .replace('{model}', dialog.model ?? '')
              : missing > 0
                ? tr('dialog.missing').replace('{n}', String(missing))
                : plan.staged.length > 0 && dialog.unstage !== true
                  ? tr('dialog.needUnstage')
                  : tr('dialog.hint');
          return h('div', { key: 'foot', className: 'dsh-sc-foot' }, [
            h('span', { key: 'hint', className: 'dsh-sc-foot-hint', title: hint }, hint),
            h(
              'button',
              { key: 'cancel', type: 'button', className: 'dsh-sc-ghost', onClick: close },
              tr('dialog.cancel'),
            ),
            dialog.stale === true
              ? h(
                  'button',
                  { key: 'again', type: 'button', className: 'dsh-sc-ghost', onClick: () => restart(tr) },
                  tr('dialog.reanalyze'),
                )
              : null,
            dialog.stale !== true && dialog.useModel === true
              ? h(
                  'button',
                  {
                    key: 'regenerate',
                    type: 'button',
                    className: 'dsh-sc-ghost',
                    disabled: phase !== 'edit',
                    onClick: () => regenerate(tr),
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
                  phase !== 'edit' ||
                  dialog.stale === true ||
                  missing > 0 ||
                  (plan.staged.length > 0 && dialog.unstage !== true),
                onClick: () => commit(),
              },
              tr('dialog.confirm'),
            ),
          ]);
        })();

        // Group rows are shared by naming, edit, and committing.
        const rows =
          plan === null
            ? null
            : plan.groups.map((group, index) => {
                const failure = dialog.failures.find((item) => item.index === index);
                const invalid = dialog.messageErrors.find((item) => item.index === index);
                const shown = Array.isArray(group.paths) ? group.paths : group.files;
                const pathText =
                  shown.length > 3
                    ? `${shown.slice(0, 3).join('\u3001')} ${tr('dialog.more').replace('{n}', String(shown.length - 3))}`
                    : shown.join('\u3001');
                return h('div', { key: `group-${index}`, className: 'dsh-sc-row' }, [
                  h('span', { key: 'idx', className: 'dsh-sc-idx' }, String(index + 1)),
                  h('div', { key: 'field', className: 'dsh-sc-field' }, [
                    h('textarea', {
                      key: 'input',
                      className: 'dsh-sc-input',
                      value: group.message,
                      rows: Math.max(1, group.message.split('\n').length),
                      spellCheck: false,
                      disabled: phase !== 'edit',
                      'data-loading': phase === 'naming' ? 'true' : undefined,
                      placeholder: group.suggestion || tr('dialog.placeholder'),
                      'aria-label': `commit message ${index + 1}`,
                      ref: (node) => {
                        if (node === null) return;
                        node.style.height = 'auto';
                        node.style.height = `${node.scrollHeight}px`;
                      },
                      onChange: (event) => {
                        updateMessage(index, event.target.value);
                        event.target.style.height = 'auto';
                        event.target.style.height = `${event.target.scrollHeight}px`;
                      },
                    }),
                    h('div', { key: 'meta', className: 'dsh-sc-meta' }, [
                      h('span', { key: 'paths', className: 'dsh-sc-paths', title: shown.join('\n') }, pathText),
                      h(
                        'span',
                        { key: 'count', className: 'dsh-sc-count' },
                        tr('dialog.files').replace('{n}', String(group.files.length)),
                      ),
                    ]),
                    failure !== undefined
                      ? h(
                          'div',
                          { key: 'failure', className: 'dsh-sc-line', 'data-kind': 'warn' },
                          tr('dialog.modelMissing').replace('{reason}', failure.reason),
                        )
                      : null,
                    invalid !== undefined
                      ? h(
                          'div',
                          { key: 'invalid', className: 'dsh-sc-line', 'data-kind': 'error' },
                          tr('dialog.invalid').replace('{reason}', invalid.reason),
                        )
                      : null,
                  ]),
                ]);
              });

        let body;
        if (phase === 'analyzing') {
          body = h('div', { key: 'body', className: 'dsh-sc-body' }, [
            h(Progress, { key: 'p', text: tr('dialog.analyzing') }),
            skeleton(),
          ]);
        } else if (phase === 'error') {
          body = h('div', { key: 'body', className: 'dsh-sc-body' }, [
            h('pre', { key: 'error', className: 'dsh-sc-pre dsh-sc-error' }, dialog.error),
          ]);
        } else if (phase === 'done') {
          body = h('div', { key: 'body', className: 'dsh-sc-body' }, [
            h('div', { key: 'label', className: 'dsh-sc-title' }, tr('dialog.done')),
            h('pre', { key: 'result', className: 'dsh-sc-pre' }, dialog.result),
          ]);
        } else {
          const progress =
            phase === 'naming'
              ? h(Progress, {
                  key: 'progress',
                  text: tr('dialog.naming')
                    .replace('{n}', String(plan.groups.length))
                    .replace('{model}', dialog.model ?? ''),
                })
              : phase === 'committing'
                ? h(Progress, { key: 'progress', text: tr('dialog.committing') })
                : null;
          body = h('div', { key: 'body', className: 'dsh-sc-body' }, [
            progress,
            dialog.error !== ''
              ? h('div', { key: 'error', className: 'dsh-sc-warn', role: 'alert' }, dialog.error)
              : null,
            ...(rows ?? []),
            plan.skipped.length > 0
              ? h(
                  'div',
                  { key: 'skipped', className: 'dsh-sc-warn' },
                  tr('dialog.skipped')
                    .replace('{n}', String(plan.skipped.length))
                    .replace('{paths}', plan.skipped.join('\u3001')),
                )
              : null,
            plan.vcs === 'svn'
              ? h('div', { key: 'svn', className: 'dsh-sc-note' }, tr('dialog.svnNote'))
              : null,
            plan.staged.length > 0
              ? h('div', { key: 'staged', className: 'dsh-sc-warn' }, [
                  h('div', { key: 'text' }, tr('dialog.staged').replace('{n}', String(plan.staged.length))),
                  h('div', { key: 'paths', className: 'dsh-sc-warn-paths' }, plan.staged.join('\n')),
                  h('label', { key: 'toggle', className: 'dsh-sc-check' }, [
                    h('input', {
                      key: 'box',
                      type: 'checkbox',
                      checked: dialog.unstage === true,
                      disabled: phase !== 'edit',
                      onChange: () => toggleUnstage(),
                    }),
                    h('span', { key: 'label' }, tr('dialog.stagedBox')),
                  ]),
                ])
              : null,
            ...(plan.warnings.length > 0
              ? [h('div', { key: 'warnings', className: 'dsh-sc-warn' }, plan.warnings.join('\uFF1B'))]
              : []),
            dialog.note !== ''
              ? h('div', { key: 'note', className: 'dsh-sc-note' }, dialog.note)
              : null,
          ]);
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
        ctx.inject(['slots'], (actionCtx) => {
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
