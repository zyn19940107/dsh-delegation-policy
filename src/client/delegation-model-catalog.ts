/**
 * The models this deployment can route to, for the extractor's model list.
 *
 * The catalog is the deployment's own answer to which models exist, so the
 * page never offers a model the Host cannot route to. It is read once and
 * kept: a failure leaves the last good list in place, because a page that
 * cannot list models must still be able to show the stored value.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** One provider and the models it can route to. */
export interface DelegationModelGroup {
  /** The provider route the models belong to. */
  readonly provider: string
  /** The model ids that route can serve. */
  readonly models: readonly string[]
}

/** What the model catalog holds. */
export interface DelegationModelCatalogState {
  /** The providers with their models. */
  readonly groups: readonly DelegationModelGroup[]
  /** Whether the catalog could not be read. */
  readonly failed: boolean
}

/**
 * A value with subscribers.
 *
 * The page reads the catalog once and republishes it on every change, so the
 * source is a value and a listener list — nothing more is needed here.
 */
class Observable<T> {
  private readonly listeners = new Set<() => void>()

  /**
   * @param initial - the value before the first read.
   */
  constructor(private value: T) {}

  /**
   * The current value.
   * @returns the value.
   */
  getSnapshot(): T {
    return this.value
  }

  /**
   * Replace the value and tell the subscribers.
   * @param next - the new value.
   */
  set(next: T): void {
    this.value = next
    for (const listener of this.listeners) listener()
  }

  /**
   * Observe value changes.
   * @param listener - called after each change.
   * @returns the disposer removing the listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/**
 * Reads the model catalog and publishes it to the page.
 */
export class DelegationModelCatalog {
  private readonly store = new Observable<DelegationModelCatalogState>({ groups: [], failed: false })
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
   *
   * A failure keeps the last good list: the page still edits the field, and
   * the failure shows beside it.
   */
  private async read(): Promise<void> {
    const generation = ++this.generation
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.generation) return
    if (!response.ok) {
      this.store.set({ ...this.store.getSnapshot(), failed: true })
      return
    }
    const groups = response.value.groups.map(group => ({
      provider: group.id,
      models: group.models.map(model => model.id),
    }))
    this.store.set({ groups, failed: false })
  }

  /**
   * The provider that owns a model id.
   *
   * A model id belongs to one provider route in the catalog, and the route is
   * what a child needs in order to reach it.
   *
   * @param modelId - the model id to look up.
   * @returns the provider route, or undefined when no group lists the model.
   */
  providerOf(modelId: string): string | undefined {
    return this.store.getSnapshot().groups.find(group => group.models.includes(modelId))?.provider
  }

  /**
   * The source the page binds.
   * @returns the catalog's snapshot source.
   */
  get source(): Observable<DelegationModelCatalogState> {
    return this.store
  }

  /** Release the catalog's subscriptions. */
  dispose(): void {
    this.generation += 1
  }
}
