/**
 * The delegation policy's settings page: the model the keyword extractor runs
 * on, and how many search terms it may name.
 *
 * The model is a list rather than a free-text field: the page offers the
 * models this deployment can route to, so the setting cannot name a model
 * that does not exist. The count is a number, because the list it governs is
 * a search budget — a term count of "three" is the whole point.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { DelegationModelCatalog, DelegationModelGroup } from './delegation-model-catalog.js'

/** Field the extractor's model is written to. */
const MODEL_FIELD = 'keywordModel'

/** Field the extractor's model provider is written to. */
const PROVIDER_FIELD = 'keywordModelProvider'

/** Field the extractor's term count is written to. */
const COUNT_FIELD = 'keywordMaxCount'

/** Props the renderer binds for the delegation page. */
export type DelegationSettingsCardProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'settings.delegationPolicy'>
  & {
    /** The models this deployment can route to. */
    readonly catalog: DelegationModelCatalog
  }

/**
 * Render the delegation policy's one-liner or its settings form, as the
 * Plugins page asks.
 *
 * @param props - the view asked for, locale copy, the Host-owned form, and the model catalog.
 * @returns the one-liner, or the form.
 */
export function DelegationSettingsCard(props: DelegationSettingsCardProps) {
  const { t } = props
  const form = props.form
  const groups = useModelGroups(props.catalog)
  if (props.view === 'summary') return t('summary')
  const value = form?.state.value as Record<string, unknown> | undefined
  const model = typeof value?.[MODEL_FIELD] === 'string' ? value[MODEL_FIELD] as string : ''
  const count = typeof value?.[COUNT_FIELD] === 'number' ? String(value[COUNT_FIELD]) : ''
  const disabled = form === undefined || !form.state.writable
  const set = (field: string, next: unknown): void => {
    void form?.mutate([{ op: 'set', path: [field], value: next as never }])
  }
  const unset = (field: string): void => {
    void form?.mutate([{ op: 'unset', path: [field] }])
  }
  return (
    <div>
      <label htmlFor="plugin-config-delegation-keyword-model">{t('modelLabel')}</label>
      <select
        id="plugin-config-delegation-keyword-model"
        value={model}
        disabled={disabled}
        onChange={(event) => {
          const chosen = event.target.value
          if (chosen === '') {
            unset(MODEL_FIELD)
            unset(PROVIDER_FIELD)
            return
          }
          // A model is only reachable through the provider that serves it, so
          // the provider is written with the model: choosing a model from
          // another route without it would leave the child unroutable.
          const provider = props.catalog.providerOf(chosen)
          if (provider === undefined) unset(PROVIDER_FIELD)
          else set(PROVIDER_FIELD, provider)
          set(MODEL_FIELD, chosen)
        }}
      >
        <option value="">{t('modelHint')}</option>
        {groups.map(group => (
          <optgroup key={group.provider} label={group.provider}>
            {group.models.map(entry => <option key={entry} value={entry}>{entry}</option>)}
          </optgroup>
        ))}
      </select>
      <label htmlFor="plugin-config-delegation-keyword-count">{t('countLabel')}</label>
      <input
        id="plugin-config-delegation-keyword-count"
        type="number"
        min={1}
        value={count}
        disabled={disabled}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          if (event.target.value.trim() === '') unset(COUNT_FIELD)
          else if (Number.isFinite(parsed)) set(COUNT_FIELD, parsed)
        }}
      />
      <p>{t('countHint')}</p>
    </div>
  )
}

/**
 * Read the model catalog's current groups.
 *
 * @param catalog - the catalog source.
 * @returns the providers and the models each one serves.
 */
function useModelGroups(catalog: DelegationModelCatalog): readonly DelegationModelGroup[] {
  const [groups, setGroups] = useState<readonly DelegationModelGroup[]>([])
  useEffect(() => {
    const store = catalog.source
    const read = (): void => { setGroups(store.getSnapshot().groups) }
    read()
    return store.subscribe(read)
  }, [catalog])
  return groups
}
