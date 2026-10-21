import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeBuddyCredential } from '../src/auth.ts'
import { CodeBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Offline tests for the enterprise-cycle fallback in `fetchCredits`.
 *
 * Why this exists: `get-user-resource` lists *personal* credit packages only, so
 * an enterprise member without a personal plan always reads zero and the dock
 * claimed "no credit package" while the web console showed the real allowance.
 * The fallback to `get-enterprise-user-usage` is the fix; these tests pin the
 * trigger conditions, the arithmetic, and the degrade-to-personal behaviour.
 */

const CREDENTIAL: CodeBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'cli',
  enterpriseId: 'ent-1',
}

/** Personal-package envelope; `fetchCredits` unwraps Response.Data.Accounts. */
function personalEnvelope(accounts: unknown[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: { Response: { Data: { Accounts: accounts } } },
  })
}

/** Enterprise-cycle envelope; `credit` is what the cycle consumed. */
function enterpriseEnvelope(data: Record<string, unknown>, code = 0): string {
  return JSON.stringify({ code, msg: code === 0 ? 'ok' : 'denied', data })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

interface Call {
  url: string
  init: RequestInit | undefined
}

/**
 * Route each billing endpoint to its own body and record every call, so a test
 * can assert *which* endpoints were touched and not merely what came back.
 */
function route(handlers: {
  personal?: string | (() => string)
  enterprise?: string | (() => string)
}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (String(url).includes('get-enterprise-user-usage')) {
      const value = handlers.enterprise
      if (value === undefined) throw new Error('enterprise endpoint must not be called')
      return fakeResponse(typeof value === 'function' ? value() : value)
    }
    if (String(url).includes('get-user-resource')) {
      const value = handlers.personal
      if (value === undefined) throw new Error('personal endpoint must not be called')
      return fakeResponse(typeof value === 'function' ? value() : value)
    }
    throw new Error(`unexpected url: ${String(url)}`)
  }) as unknown as typeof fetch)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchCredits → enterprise cycle fallback', () => {
  it('reads the enterprise cycle when the member has no personal package', async () => {
    const calls = route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({
        credit: 500,
        limitNum: 20_000,
        cycleStartTime: '2026-10-18 00:00:00',
        cycleEndTime: '2026-11-17 23:59:59',
      }),
    })

    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)

    // 20000 allowance − 500 consumed = 19500 left.
    expect(credits.total).toBe(19_500)
    expect(credits.accounts).toHaveLength(1)
    expect(credits.accounts[0]).toMatchObject({
      packageName: 'Enterprise quota',
      total: 20_000,
      size: 20_000,
      remain: 19_500,
      used: 500,
    })
    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      '/v2/billing/meter/get-user-resource',
      '/billing/meter/get-enterprise-user-usage',
    ])
  })

  it('POSTs an empty JSON object to the enterprise endpoint', async () => {
    const calls = route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({ credit: 1, limitNum: 100 }),
    })
    await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)

    const enterpriseCall = calls.find(call => call.url.includes('get-enterprise-user-usage'))
    expect(enterpriseCall?.init?.method).toBe('POST')
    expect(enterpriseCall?.init?.body).toBe('{}')
  })

  it('does not ask the enterprise endpoint when a personal package exists', async () => {
    const calls = route({
      personal: personalEnvelope([
        { PackageName: 'pkg-a', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
      ]),
      // No enterprise handler: calling it would throw.
    })

    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)

    expect(credits.total).toBe(40)
    expect(credits.accounts[0]?.packageName).toBe('pkg-a')
    expect(calls).toHaveLength(1)
  })

  it('does not ask the enterprise endpoint without an enterprise id', async () => {
    const calls = route({
      personal: personalEnvelope([]),
    })
    // Destructure the field away rather than setting it to undefined: the
    // credential type declares `enterpriseId?: string`, so an explicit
    // undefined is not assignable.
    const { enterpriseId: _omitted, ...withoutEnterprise } = CREDENTIAL
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(withoutEnterprise)

    expect(credits.total).toBe(0)
    expect(credits.accounts).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('treats a blank enterprise id as absent', async () => {
    const calls = route({
      personal: personalEnvelope([]),
    })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits({ ...CREDENTIAL, enterpriseId: '' })

    expect(credits.accounts).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  it('degrades to the personal answer when the enterprise call errors', async () => {
    route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({}, 40_403),
    })

    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)

    // Not an exception: the status document still renders, just without quota.
    expect(credits.total).toBe(0)
    expect(credits.accounts).toHaveLength(0)
  })

  it('degrades when the enterprise response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      String(url).includes('get-enterprise-user-usage')
        ? fakeResponse('<html>gateway</html>')
        : fakeResponse(personalEnvelope([]))
    )) as unknown as typeof fetch)

    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts).toHaveLength(0)
  })

  it('degrades when limitNum is missing or non-positive', async () => {
    for (const data of [{ credit: 5 }, { credit: 5, limitNum: 0 }, { credit: 5, limitNum: -1 }, { limitNum: 'abc' }]) {
      route({ personal: personalEnvelope([]), enterprise: enterpriseEnvelope(data) })
      const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
      expect(credits.accounts).toHaveLength(0)
      expect(credits.total).toBe(0)
    }
  })

  it('treats a missing credit as zero consumption', async () => {
    route({ personal: personalEnvelope([]), enterprise: enterpriseEnvelope({ limitNum: 1_000 }) })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]).toMatchObject({ remain: 1_000, used: 0 })
  })

  it('accepts numeric strings, as the upstream sometimes sends them', async () => {
    route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({ credit: '250', limitNum: '1000' }),
    })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]).toMatchObject({ total: 1_000, remain: 750, used: 250 })
  })

  it('clamps an over-consumed cycle to zero remain instead of going negative', async () => {
    route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({ credit: 25_000, limitNum: 20_000 }),
    })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]?.remain).toBe(0)
    expect(credits.total).toBe(0)
    // The raw overspend is preserved so the dock can explain it.
    expect(credits.accounts[0]?.used).toBe(25_000)
  })

  it('marks the cycle expired once cycleEndTime is in the past', async () => {
    route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({
        credit: 0,
        limitNum: 100,
        cycleEndTime: '2000-01-01 00:00:00',
      }),
    })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]?.expired).toBe(true)
    expect(credits.accounts[0]?.expiringSoon).toBe(false)
  })

  it('marks a cycle ending within a week as expiring soon', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000)
    const stamp = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')} 12:00:00`
    route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({ credit: 0, limitNum: 100, cycleEndTime: stamp }),
    })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]?.expired).toBe(false)
    expect(credits.accounts[0]?.expiringSoon).toBe(true)
  })

  it('leaves expiry flags off when cycleEndTime is unusable', async () => {
    route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({ credit: 0, limitNum: 100, cycleEndTime: 'not-a-date' }),
    })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]?.expired).toBe(false)
    expect(credits.accounts[0]?.expiringSoon).toBe(false)
    expect(credits.accounts[0]?.expireAtMs).toBe(undefined)
  })

  it('reports the enterprise cycle as the total, not per-package sum', async () => {
    route({
      personal: personalEnvelope([]),
      enterprise: enterpriseEnvelope({ credit: 1_000, limitNum: 20_000 }),
    })
    const credits = await new CodeBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts).toHaveLength(1)
    expect(credits.total).toBe(19_000)
    expect(credits.accounts[0]?.total).toBe(20_000)
  })
})
