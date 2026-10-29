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
import { SettingsForm, SettingsValueField, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import {
  COUNT_FIELD,
  JUDGEMENT_FIELD,
  MODEL_FIELD,
  PROVIDER_FIELD,
  type DelegationCardController,
  type DelegationCardState,
} from './delegation-card-controller.js'
import { styles } from './delegation-styles.js'
import { formLabels } from './locales.js'

/** Props the renderer binds for the delegation page. */
export type DelegationSettingsCardProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'settings.delegationPolicy'>
  & {
    /** The page's staged form and the models this deployment can route to. */
    readonly controller: DelegationCardController
  }

/**
 * Render the delegation policy's one-liner or its settings form, as the
 * Plugins page asks.
 *
 * @param props - the view asked for, locale copy, and the page's form.
 * @returns the one-liner, or the form.
 */
export function DelegationSettingsCard(props: DelegationSettingsCardProps) {
  const { t } = props
  const state = useCardState(props.controller)
  if (props.view === 'summary') return t('summary')
  const actions = props.controller.actions()
  return (
    <SettingsForm
      labels={formLabels(t)}
      state={state}
      onSave={actions.save}
      onDiscard={actions.discard}
    >
      <ModelField
        id="plugin-config-delegation-keyword-model"
        label={t('modelLabel')}
        hint={t('modelHint')}
        inheritLabel={t('modelInherit')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        state={state}
        onEdit={actions.edit}
        onReset={() => {
          actions.edit(MODEL_FIELD, '')
          actions.edit(PROVIDER_FIELD, '')
        }}
      />
      <SettingsValueField
        id="plugin-config-delegation-keyword-count"
        label={t('countLabel')}
        hint={t('countHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.keywordMaxCount}
        onEdit={(text) => { actions.edit(COUNT_FIELD, text) }}
        onReset={() => { actions.resetField(COUNT_FIELD) }}
      />
      <div className={styles.field}>
        <div className={styles.head}>
          <span className={styles.label}>{t('judgementLabel')}</span>
        </div>
        <Switch
          label={t('judgementLabel')}
          checked={state.judgementEnabled.text === 'on'}
          disabled={!state.writable}
          onChange={(checked) => { actions.edit(JUDGEMENT_FIELD, checked ? 'on' : 'off') }}
        />
        <p className={styles.hint}>{t('judgementHint')}</p>
      </div>
    </SettingsForm>
  )
}

/** What the model control needs. */
interface ModelFieldProps {
  /** Stable id associating the label with its control. */
  readonly id: string
  /** Visible label. */
  readonly label: string
  /** One-line explanation rendered under the control. */
  readonly hint: string
  /** Copy for the choice that inherits the conversation's model. */
  readonly inheritLabel: string
  /** Copy for the overridden badge. */
  readonly overriddenLabel: string
  /** Copy for the reset control. */
  readonly resetLabel: string
  /** The page's current state. */
  readonly state: DelegationCardState
  /** Stage draft text for one field. */
  readonly onEdit: (field: string, text: string) => void
  /** Stage a clear for the model and the provider with it. */
  readonly onReset: () => void
}

/**
 * The model control: a list of the deployment's routable models, grouped by
 * the provider that serves them, plus the empty choice that means "the same
 * model this conversation runs on".
 *
 * @param props - the control's copy, the page's state, and the edit actions.
 * @returns the labelled control.
 */
function ModelField(props: ModelFieldProps) {
  const { state } = props
  const disabled = !state.writable
  return (
    <div className={styles.field}>
      <div className={styles.head}>
        <label className={styles.label} htmlFor={props.id}>{props.label}</label>
        {state.keywordModel.overridden
          ? (
            <span className={styles.badges}>
              <Tag tone="neutral">{props.overriddenLabel}</Tag>
              <button
                type="button"
                className={styles.reset}
                disabled={disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <select
        id={props.id}
        className={styles.control}
        value={state.keywordModel.text}
        disabled={disabled}
        onChange={(event) => {
          const chosen = event.target.value
          if (chosen === '') {
            props.onReset()
            return
          }
          props.onEdit(MODEL_FIELD, chosen)
          const provider = state.groups.find(group => group.models.includes(chosen))?.provider
          props.onEdit(PROVIDER_FIELD, provider ?? '')
        }}
      >
        <option value="">{props.inheritLabel}</option>
        {state.groups.map(group => (
          <optgroup key={group.provider} label={group.provider}>
            {group.models.map(model => <option key={model} value={model}>{model}</option>)}
          </optgroup>
        ))}
      </select>
      <p className={styles.hint}>{props.hint}</p>
    </div>
  )
}

/**
 * Read the page's state and follow it.
 *
 * @param controller - the page's staged form.
 * @returns the state the page renders.
 */
function useCardState(controller: DelegationCardController): DelegationCardState {
  const [state, setState] = useState(() => controller.state())
  useEffect(() => controller.subscribe(() => { setState(controller.state()) }), [controller])
  return state
}
