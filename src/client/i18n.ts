/**
 * Locale tables and the translator.
 *
 * The Host passes a `t` prop when the slot system already resolved a
 * translator; otherwise the raw locale snapshot decides between English and
 * Chinese, with English as the fallback for every missing key.
 */

import type { ClientContext, LocaleSnapshot } from './context.js';

export type Translator = (key: string) => string;

export const EN: Record<string, string> = {
  'action.label': 'Commit',
  'action.busy': 'Working\u2026',
  'action.open': 'Confirming',
  'action.failed': 'Failed',
  'action.cleanShort': 'Clean',
  'action.noSession': 'Open a session first.',
  'action.title': 'Let the current model decide the commit groups and name each of them.',
  'dialog.title': 'Confirm commit',
  'dialog.hint': 'Model groups; messages editable; the host validates.',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Commit',
  'dialog.committing': 'Committing\u2026',
  'dialog.analyzing': 'Reading the working tree\u2026',
  'dialog.naming': 'Planning the groups with {model}\u2026',
  'dialog.manual': 'The model did not name every group. Write the missing messages by hand.',
  'dialog.done': 'Result',
  'dialog.close': 'Close',
  'dialog.reanalyze': 'Analyze again',
  'dialog.regenerate': 'Regroup and rename',
  'dialog.files': '{n} files',
  'dialog.more': '+{n} more',
  'dialog.collapse': 'Show less',
  'dialog.selected': '{n} files selected',
  'dialog.moveTo': 'Move to',
  'dialog.clearSelection': 'Clear selection',
  'dialog.newGroup': 'New group',
  'dialog.groupN': 'Group {n}',
  'dialog.mergeUp': 'Merge this group into the previous one',
  'dialog.edited': 'Grouping changed',
  'dialog.selectGroup': 'Select all {n}',
  'dialog.clearGroup': 'Deselect group',
  'dialog.regroupHint':
    'Drag files between groups, or select and move them; Shift-click extends the selection.',
  'dialog.closeLabel': 'Close dialog',
  'dialog.svnNote':
    'SVN working copy: commits use explicit paths, one revision per group. There is no staging area.',
  'dialog.summary': '{groups} groups, {files} files',
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

export const ZH: Record<string, string> = {
  'action.label': '提交',
  'action.busy': '处理中\u2026',
  'action.open': '确认中',
  'action.failed': '失败',
  'action.cleanShort': '无改动',
  'action.noSession': '先打开一个会话。',
  'action.title': '由当前模型决定分几组，并为每组生成 message。',
  'dialog.title': '确认提交',
  'dialog.hint': '分组由模型给出，message 可改，提交前统一校验。',
  'dialog.cancel': '取消',
  'dialog.confirm': '确认提交',
  'dialog.committing': '提交中\u2026',
  'dialog.analyzing': '正在读取工作区\u2026',
  'dialog.naming': '正在用 {model} 规划分组\u2026',
  'dialog.manual': '模型没有为每一组生成 message，缺失的可以手动补写。',
  'dialog.done': '提交结果',
  'dialog.close': '关闭',
  'dialog.reanalyze': '重新分析',
  'dialog.regenerate': '重新分组并命名',
  'dialog.files': '{n} 个文件',
  'dialog.more': '等 {n} 个',
  'dialog.collapse': '收起',
  'dialog.selected': '已选 {n} 个文件',
  'dialog.moveTo': '移动到',
  'dialog.clearSelection': '取消选择',
  'dialog.newGroup': '新建分组',
  'dialog.groupN': '第 {n} 组',
  'dialog.mergeUp': '合并到上一组',
  'dialog.edited': '分组已调整',
  'dialog.selectGroup': '全选 {n} 个',
  'dialog.clearGroup': '取消本组',
  'dialog.regroupHint': '把文件拖到目标分组，或多选后统一移动；Shift 点击连选。',
  'dialog.closeLabel': '关闭弹窗',
  'dialog.svnNote': 'SVN 工作副本：按路径提交，每组一个 revision；没有暂存区。',
  'dialog.summary': '{groups} 组，{files} 个文件',
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

/**
 * Resolve the translator for one component instance.
 * @param ctx - the plugin context that owns the locale service.
 * @param props - the slot props, which may already carry a `t`.
 * @returns a key-to-text function.
 */
export function translator(ctx: ClientContext | undefined, props?: { t?: unknown }): Translator {
  if (typeof props?.t === 'function') return props.t as Translator;
  let id = '';
  try {
    const snapshot = ctx?.locale?.getLocale?.();
    if (typeof snapshot === 'string') {
      id = snapshot;
    } else if (snapshot !== null && typeof snapshot === 'object') {
      const value = snapshot as LocaleSnapshot;
      const raw = value.id ?? value.locale ?? '';
      id = typeof raw === 'string' ? raw : String(raw);
    }
  } catch {
    /* fall back to English */
  }
  const table = id.toLowerCase().startsWith('zh') ? ZH : EN;
  return (key) => table[key] ?? FALLBACK[key] ?? key;
}
