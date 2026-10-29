/**
 * The delegation page's staged form over the `delegation-policy` namespace.
 *
 * The form stages two decisions: the model the keyword extractor runs on, and
 * how many search terms it may name. The model field's accepted values are the
 * models this deployment can actually route to, so the page offers a list
 * rather than a free-text field that could name a model that does not exist.
 *
 * Choosing a model writes the provider with it: a model id is only reachable
 * through the route that serves it, and a child that names a model of another
 * route is unroutable.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormShell,
  type SettingsFormScope,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Field the extractor's model is written to. */
export const MODEL_FIELD = 'keywordModel'

/** Field the extractor's model provider is written to. */
export const PROVIDER_FIELD = 'keywordModelProvider'

/** Field the extractor's term count is written to. */
export const COUNT_FIELD = 'keywordMaxCount'

/** Field the judgement gate's switch is written to. */
export const JUDGEMENT_FIELD = 'judgementEnabled'

/** The fields this page edits. */
export interface DelegationSettings {
  /** The model the extractor runs on; the parent's when absent. */
  keywordModel?: string
  /** The llm provider that route belongs to. */
  keywordModelProvider?: string
  /** How many search terms the extractor may name. */
  keywordMaxCount?: number
  /** Whether a turn must classify its question before it may end. */
  judgementEnabled?: boolean
}

/** One provider and the models it can route to. */
export interface DelegationModelGroup {
  /** The provider route the models belong to. */
  readonly provider: string
  /** The model ids that route can serve. */
  readonly models: readonly string[]
}

/**
 * A switch field.
 *
 * The shared form model knows text and number fields; a switch is its own
 * conversion, so this page carries the one it needs.
 *
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => (typeof value === 'boolean' ? (value ? 'on' : 'off') : 'off'),
    parse: (text) => ({ kind: 'set', value: text.trim() === 'on' }),
  }
}

/** What the page renders. */
export interface DelegationCardState extends SettingsFormShell {
  /** The extractor's model. */
  keywordModel: SettingsFieldState
  /** The extractor's term count. */
  keywordMaxCount: SettingsFieldState
  /** The judgement gate's switch. */
  judgementEnabled: SettingsFieldState
  /** The providers with their models. */
  groups: readonly DelegationModelGroup[]
  /** Whether the model catalog could not be read. */
  catalogFailed: boolean
}

/**
 * Reads the model catalog and publishes it to the page.
 *
 * The catalog is the deployment's own answer to which models exist, so the
 * page never offers a model the Host cannot route to. A failure keeps the last
 * good list: the page still edits the field, and the failure shows beside it.
 */
export class DelegationModelCatalog {
  private groups: readonly DelegationModelGroup[] = []
  private failed = false
  private generation = 0

  /**
   * @param ctx - the page plugin's context, whose `remote.session` namespace
   * answers for the catalog.
   */
  constructor(private readonly ctx: ClientContext) {
    void this.read()
  }

  /**
   * Read the catalog and publish it.
   */
  private async read(): Promise<void> {
    const generation = ++this.generation
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.generation) return
    if (!response.ok) {
      this.failed = true
      this.onChange()
      return
    }
    this.groups = response.value.groups.map(group => ({
      provider: group.id,
      models: group.models.map(model => model.id),
    }))
    this.failed = false
    this.onChange()
  }

  /** Called after the catalog changed. */
  onChange: () => void = () => {}

  /**
   * The providers and their models.
   * @returns the catalog's groups.
   */
  get current(): readonly DelegationModelGroup[] {
    return this.groups
  }

  /**
   * Whether the catalog could not be read.
   * @returns true when the last read failed.
   */
  get catalogFailed(): boolean {
    return this.failed
  }

  /**
   * The provider that owns a model id.
   *
   * @param modelId - the model id to look up.
   * @returns the provider route, or undefined when no group lists the model.
   */
  providerOf(modelId: string): string | undefined {
    return this.groups.find(group => group.models.includes(modelId))?.provider
  }
}

/**
 * Bridges the `delegation-policy` scope and the model catalog onto the page.
 */
export class DelegationCardController {
  private readonly form: SettingsFormModel<DelegationSettings>
  private readonly catalog: DelegationModelCatalog
  private readonly store: SnapshotStore<DelegationCardState>

  /**
   * @param scope - the bound settings scope for the `delegation-policy` namespace.
   * @param catalog - the models this deployment can route to.
   */
  constructor(
    scope: SettingsFormScope<DelegationSettings>,
    catalog: DelegationModelCatalog,
  ) {
    this.catalog = catalog
    this.form = new SettingsFormModel(
      scope,
      [
        settingsTextField(MODEL_FIELD),
        settingsTextField(PROVIDER_FIELD),
        settingsNumberField(COUNT_FIELD),
        settingsBooleanField(JUDGEMENT_FIELD),
      ],
    )
    this.store = this.form.bind(() => this.projection())
    catalog.onChange = () => { this.store.set(this.projection()) }
  }

  /**
   * The page's snapshot.
   * @returns the state the page renders.
   */
  state(): DelegationCardState {
    return this.store.getSnapshot()
  }

  /** The page's state, rebuilt from the form and the catalog. */
  private projection(): DelegationCardState {
    return {
      ...this.form.shell(),
      keywordModel: this.form.field(MODEL_FIELD),
      keywordMaxCount: this.form.field(COUNT_FIELD),
      judgementEnabled: this.form.field(JUDGEMENT_FIELD),
      groups: this.catalog.current,
      catalogFailed: this.catalog.catalogFailed,
    }
  }

  /**
   * The write actions the page binds.
   * @returns the staged edit, reset, save, and discard actions.
   */
  actions(): SettingsFormActions {
    return this.form.actions()
  }

  /**
   * Subscribe to the page's state.
   * @param listener - called after every change.
   * @returns the disposer removing the listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Release the form's subscription. */
  dispose(): void {
    this.form.dispose()
  }
}
