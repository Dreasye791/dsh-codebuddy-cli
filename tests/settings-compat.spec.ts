import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as CodeBuddy from '../src/index.ts'
import { installSettingsSectionCompat, resolveSettingsNamespaceCompat } from '../src/settings-compat.ts'

/**
 * DSH 0.2.1 removed both older settings installers (`installSettingsSection`
 * from the package and `installSection` from the provider). Forms are derived
 * from the plugin's own Loader-entry Config, and a plugin with a custom card
 * opts out through `configure({ auto: false })`.
 *
 * The real `SettingsForms` service now injects the host's `configEditor` and
 * `profileContext`, neither of which exists outside a booted profile — so these
 * tests stand in a minimal provider exposing exactly the surface this plugin
 * uses. That keeps the assertions on the plugin's own contract rather than on
 * host plumbing.
 */

/** The surface this plugin actually touches on the settings service. */
interface FakeSettings {
  configure: ReturnType<typeof vi.fn>
  describe: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

function mountFakeSettings(ctx: Context, options: { namespace?: string, value?: unknown } = {}): FakeSettings {
  const fake: FakeSettings = {
    configure: vi.fn(() => () => {}),
    describe: vi.fn(() => [{
      ns: (options.namespace ?? CodeBuddy.CODEBUDDY_SETTINGS_NS) as SettingsNamespace,
      value: options.value ?? {},
    }]),
    update: vi.fn(async () => {}),
  }
  ctx.provide('settings', fake as never)
  return fake
}

describe('settings integration on the managed-forms generation', () => {
  it('registers the custom-page opt-out without throwing', async () => {
    const ctx = new Context()
    const settings = mountFakeSettings(ctx)

    // A host that still expected an installer would throw here; 0.2.1 has no
    // installer at all, so this must instead register the page policy.
    expect(() => installSettingsSectionCompat(ctx, CodeBuddy.CODEBUDDY_SETTINGS_NS, () => {})).not.toThrow()

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settings.configure).toHaveBeenCalled()
    // The plugin ships its own card, so the generated page must stay off.
    expect(settings.configure.mock.calls[0]?.[0]).toEqual({ auto: false })

    await ctx.fiber.dispose()
  })

  it('needs no settings service to stay harmless', async () => {
    // A headless profile serves no browser and mounts no settings provider; the
    // plugin must still load and serve its models there.
    const ctx = new Context()
    expect(() => installSettingsSectionCompat(ctx, CodeBuddy.CODEBUDDY_SETTINGS_NS, () => {})).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('resolves the section namespace from the loader entry', async () => {
    const ctx = new Context()

    // Without an entry the plugin's public constant is the answer.
    expect(resolveSettingsNamespaceCompat(ctx, CodeBuddy.CODEBUDDY_SETTINGS_NS))
      .toBe(CodeBuddy.CODEBUDDY_SETTINGS_NS)

    // The managed-forms provider addresses sections by the loader entry id, so a
    // context carrying one resolves to that id instead.
    const withEntry = ctx.isolate('probe')
    Object.defineProperty(withEntry, 'fiber', {
      value: { entry: { options: { id: 'llm-codebuddy-cli' } } },
      configurable: true,
    })
    expect(resolveSettingsNamespaceCompat(withEntry, CodeBuddy.CODEBUDDY_SETTINGS_NS))
      .toBe('llm-codebuddy-cli')

    await ctx.fiber.dispose()
  })

  it('survives a context with no loader service', async () => {
    // Reading an undeclared cordis service throws; resolving the namespace must
    // not depend on the loader being reachable from this fiber.
    const ctx = new Context()
    expect(() => resolveSettingsNamespaceCompat(ctx, CodeBuddy.CODEBUDDY_SETTINGS_NS)).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('notifies on a document update for its own namespace only', async () => {
    const ctx = new Context()
    const settings = mountFakeSettings(ctx)

    const onChange = vi.fn()
    installSettingsSectionCompat(ctx, CodeBuddy.CODEBUDDY_SETTINGS_NS, onChange)
    await new Promise(resolve => setTimeout(resolve, 20))

    // Another plugin's section must not trigger this plugin's re-read.
    ctx.emit('settings/document-updated', 'some-other-plugin' as SettingsNamespace, 1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(onChange).not.toHaveBeenCalled()

    // Its own namespace must — that is how a live edit reaches `current`.
    ctx.emit('settings/document-updated', CodeBuddy.CODEBUDDY_SETTINGS_NS, 2)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(onChange).toHaveBeenCalled()
    expect(settings.describe).toBeDefined()

    await ctx.fiber.dispose()
  })
})
