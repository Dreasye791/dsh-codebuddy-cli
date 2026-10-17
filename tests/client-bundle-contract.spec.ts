import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Contract tests over the BUILT client bundle.
 *
 * Two DSH 0.1.7 renames broke the settings card silently — the host served a
 * bundle whose slot nothing renders, and whose icon import resolved to
 * `undefined` (React error #130), so the card appeared as a blank tab with no
 * error dialog. Neither failure is reachable from the source-level tests, so
 * these assertions read `lib/client.js` itself: it is the artifact the browser
 * actually loads.
 *
 * Skip (rather than fail) when the bundle is absent: `npm test` runs before
 * `npm run build` in a clean checkout.
 */
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

let bundle: string | undefined
try {
  bundle = readFileSync(bundlePath, 'utf8')
} catch {
  bundle = undefined
}

const maybe = bundle === undefined ? describe.skip : describe

maybe('built client bundle slot + icon contract', () => {
  it('registers the current plugin-configuration slot name', () => {
    // `settings.plugins.tab` is what DSH 0.1.7 renders; the older
    // `settings.plugin.item` is consumed by nothing any more.
    expect(bundle).toContain('settings.plugins.tab')
  })

  it('still registers the legacy slot name so older DSH builds keep working', () => {
    expect(bundle).toContain('settings.plugin.item')
  })

  it('labels the tab, so the strip never shows an unlabelled blank tab', () => {
    // The slot contract documents `label` as the registrant-localized tab text.
    // It resolves the short `tabLabel` key (the tab shares a row with the
    // host's own tabs), not the full card title.
    expect(bundle).toMatch(/label:\s*\(\)\s*=>\s*t\("tabLabel"\)/)
  })

  it('does not import the retired size-suffixed icon name', () => {
    // `IconChevronDownOutline14` is gone in 0.1.7; importing it yields
    // `undefined` and React rejects the element type (error #130).
    expect(bundle).not.toContain('IconChevronDownOutline14')
  })

  it('imports the current primitive icon name that the host actually exports', () => {
    expect(bundle).toContain('IconChevronDownOutlineRegular')
  })

  it('gates the dock row on the setting instead of hiding it unconditionally', () => {
    // The dock shares a flex line with the host's session-stats strip, so an
    // extra row on a foreign provider can squeeze the rounds/token segments into
    // ellipsis (#6). The row must stay visible by default and bail out only when
    // the operator turned it off — a hardcoded `!codeBuddy` return would silently
    // remove the provider name the reporter asked to keep.
    expect(bundle).toMatch(/if \(!codeBuddy && !showOnOtherProviders\)/)
    expect(bundle).not.toMatch(/if \(!codeBuddy\)\s*return null/)
  })
})
