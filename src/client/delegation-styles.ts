/**
 * The delegation page's styles.
 *
 * The package builds outside the harness repository, so it has no CSS-modules
 * pipeline: the sheet travels as a string and is injected once, under
 * package-owned class names. Every colour is a `--dsw-*` token, so the page
 * follows the deployment's theme instead of carrying one of its own.
 */

/** The sheet's class names, one per rule. */
const CLASS = {
  field: 'dsh-delegation-field',
  head: 'dsh-delegation-head',
  label: 'dsh-delegation-label',
  badges: 'dsh-delegation-badges',
  reset: 'dsh-delegation-reset',
  control: 'dsh-delegation-control',
  hint: 'dsh-delegation-hint',
  invalid: 'dsh-delegation-invalid',
  catalog: 'dsh-delegation-catalog',
  catalogError: 'dsh-delegation-catalog-error',
} as const

/** The sheet's rules. */
const RULES = `
.${CLASS.field} {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.${CLASS.field} + .${CLASS.field} {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.${CLASS.head} {
  display: flex;
  align-items: center;
  gap: 8px;
}
.${CLASS.label} {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.${CLASS.badges} {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.${CLASS.reset} {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.${CLASS.reset}:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.${CLASS.reset}:disabled {
  cursor: default;
}
.${CLASS.control} {
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.${CLASS.control}:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.${CLASS.control}:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.${CLASS.control}[aria-invalid='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}
.${CLASS.hint} {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${CLASS.invalid} {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}
.${CLASS.catalog} {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.${CLASS.catalogError} {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-warn-primary);
}
`

/** The class names the sheet defines. */
export const styles = CLASS

let injected = false

/**
 * Put the sheet into the document, once.
 *
 * The sheet is idempotent: a second call adds nothing, so a page that mounts
 * the form twice still carries one copy of the rules.
 */
export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.dshDelegationPolicy = 'settings'
  style.textContent = RULES
  document.head.append(style)
}
