/**
 * Settings integration for the managed-forms generation of `dsh-settings`.
 *
 * DSH 0.2.1 removed both older installers (`installSettingsSection` from the
 * package and `installSection` from the provider). Forms are now derived from
 * the plugin's own Loader-entry Config schema, and a plugin only opts out of
 * the auto-generated page via `configure({ auto: false })`.
 *
 * This plugin ships a richer card of its own, so it always takes that opt-out
 * path. Hosts older than 0.2.1 are not supported: their users should install
 * the matching older release of this plugin, which carried the multi-generation
 * bridge this module replaces.
 *
 * @module dsh-codebuddy-cli/settings-compat
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsForms } from '@deepseek-ai/dsh-settings'

/**
 * The Loader entry id of the plugin instance owning `ctx`, when available.
 *
 * The managed-forms provider addresses sections by this id (its namespace is
 * `entry.options.id`), which is the composition entry's id — for this plugin
 * `llm-codebuddy-cli`, not the legacy display id.
 */
function entryNamespaceOf(ctx: Context): SettingsNamespace | undefined {
  const compat = ctx as unknown as {
    fiber?: { entry?: { id?: unknown; options?: { id?: unknown } } }
    loader?: { locate?: (fiber?: unknown) => unknown }
  }
  const entry = compat.fiber?.entry
  const candidates: unknown[] = [entry?.options?.id, entry?.id]
  // Cordis throws when a service is read without declaring it in `inject`, so
  // `ctx.loader` is only consulted when the fiber actually holds it.
  try {
    candidates.push(compat.loader?.locate?.(compat.fiber))
  } catch {
    // No loader on this host; the entry ids above are the whole answer.
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate as SettingsNamespace
  }
  return undefined
}

/**
 * The namespace the settings bridge reads and writes.
 *
 * The managed-forms provider derives sections from the profile entry, so its
 * namespace is the entry id; the plugin's own constant is only the fallback for
 * a context that cannot name its entry yet. Callers that only care about the
 * stable public wire contract keep using their own constant and translate here.
 */
export function resolveSettingsNamespaceCompat(
  ctx: Context,
  fallback: SettingsNamespace,
): SettingsNamespace {
  return entryNamespaceOf(ctx) ?? fallback
}

/**
 * Opt this plugin instance out of the auto-generated settings page.
 *
 * `current` keeps tracking the composition entry by default, so the plugin does
 * not need to hand a source back to the provider. A live edit lands in the
 * settings document, and the caller re-reads it through the settings service.
 *
 * Without a settings service the plugin still serves its models; it simply has
 * no user-editable section, so this degrades to a no-op.
 *
 * @param ctx Plugin context whose effects own the registration.
 * @param namespace The section namespace this plugin publishes.
 * @param onChange Called after the plugin's own document entry changes.
 */
export function installSettingsSectionCompat(
  ctx: Context,
  namespace: SettingsNamespace,
  onChange: () => void,
): void {
  ctx.inject(['settings'], sctx => {
    const provider = sctx.get('settings') as unknown as Pick<SettingsForms, 'configure' | 'describe'> | undefined
    if (provider === undefined || provider.configure === undefined) return

    // Managed forms build the page from this plugin's Config; the plugin ships
    // its own richer card instead, so the auto-generated page is disabled.
    sctx.effect(() => provider.configure?.({ auto: false }, ctx.fiber))

    // A live edit lands in the settings document, and the event carries only the
    // namespace — never the new values. Re-read the section so a consumer that
    // keeps its own `current` thunk (this plugin reads `authFile` and
    // `enabledModels` through one) does not keep serving startup values.
    const refresh = (): void => {
      onChange()
    }
    const settingsEvents = sctx as unknown as {
      on(event: 'settings/document-updated', listener: (updated: unknown) => void): () => void
    }
    sctx.effect(() => settingsEvents.on('settings/document-updated', updated => {
      if (String(updated) === namespace) refresh()
    }))
  })
}
