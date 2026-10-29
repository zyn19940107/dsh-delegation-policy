/** Locale bundles for the delegation policy's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type DelegationSettingsLocaleKey =
  | 'title' | 'summary'
  | 'modelLabel' | 'modelHint'
  | 'countLabel' | 'countHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<DelegationSettingsLocaleKey, string> = {
  title: 'Delegation policy',
  summary: 'Route external facts and long reasoning to delegated children.',
  modelLabel: 'Keyword extractor model',
  modelHint: 'Leave empty to use the model this conversation runs on.',
  countLabel: 'Max search terms per thought',
  countHint: 'How many terms the extractor may name for one delegated thought.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<DelegationSettingsLocaleKey, string> = {
  title: '委派策略',
  summary: '把外部事实和长推理交给被委派的子代理。',
  modelLabel: '关键词提取器使用的模型',
  modelHint: '留空则使用本次对话所用的模型。',
  countLabel: '每次思考最多提取的名词概念数',
  countHint: '一次委派思考中，提取器最多可以命名多少个检索词。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: DelegationSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
