/**
 * The delegation policy's settings page, browser half.
 *
 * The page owns the two decisions a user makes about the delegated pipeline:
 * which model the keyword extractor runs on, and how many search terms it may
 * name. Every other knob is a fixed policy the user rarely revisits.
 *
 * The page registers into the Plugins page's `plugins.row.config` slot under
 * this bundle's row, so it appears on the row's own page while the Host serves
 * the namespace.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.remote Context merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.configForms Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.row.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DelegationSettingsCard } from './DelegationSettingsCard.js'
import { DelegationModelCatalog } from './delegation-model-catalog.js'
import { en, zh, type DelegationSettingsLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Delegation policy settings page copy. */
    'settings.delegationPolicy': DelegationSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.delegationPolicy'

/** Settings namespace the Host serves for this plugin's Loader row. */
export const DELEGATION_NS = 'delegation-policy'

/** The bundle package name this page's row belongs to. */
const BUNDLE = '@zyn19940107/dsh-delegation-policy'

/** The row id this plugin's own bundle declares. */
const ROW_ID = 'delegation-policy'

/** The `plugins.row.config` key this page registers under. */
const ROW_KEY = `${BUNDLE}#${ROW_ID}`

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

/**
 * Register the delegation policy's page on the Plugins page.
 *
 * The page appears only while the Host serves the plugin's namespace: a
 * deployment without the plugin shows no trace of it.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-delegation-policy: dictionaries')
  const catalog = new DelegationModelCatalog(ctx)
  ctx.effect(() => () => { catalog.dispose() }, 'dsh-delegation-policy: model catalog')
  ctx.effect(
    () => ctx.configForms.whileServed([DELEGATION_NS], () => ctx.slots.register({
      name: 'plugins.row.config',
      key: ROW_KEY,
      locale: NS,
    }, props => <DelegationSettingsCard {...props} catalog={catalog} />)),
    'dsh-delegation-policy: page',
  )
}
