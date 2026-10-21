/**
 * Shared loopback gates for the plugin's local HTTP surfaces: the loopback
 * shim and the same-origin web-status route. Both are only ever meant to be
 * addressed through the machine's loopback interface.
 *
 * @module dsh-codebuddy-cli/loopback
 */

/** Loopback hostnames a local plugin surface may be addressed by. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  // Only `name:port` with a single colon is a port; anything with more colons
  // is an (unbracketed) IPv6 literal and must not be truncated.
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser
 * clients (the plugin's own fetch calls) send no Origin at all and pass.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Signals a mutating request may carry when it arrives without an Origin.
 *
 * `Sec-Fetch-Site` is a forbidden request header: page script cannot set it,
 * so its absence cannot be forged by a cross-site page. Values that mean
 * "another site initiated this" are refused outright; `none` and `same-origin`
 * are the browser's own top-level and same-origin navigations.
 */
const CROSS_SITE_FETCH_SITES = new Set(['cross-site', 'same-site'])

/**
 * Decide whether a mutating local request may proceed.
 *
 * An Origin that is present must be loopback, exactly as before. The extra
 * requirement that an Origin be *present* only exists to stop cross-site
 * pages, which is why it is now conditional: a request with no Origin passes
 * when nothing marks it as cross-site, and the Host check above still rejects
 * DNS-rebinding pages. Desktop shells that proxy loopback traffic under a
 * custom scheme strip Origin before forwarding, and those were getting a 403.
 *
 * @param headers request headers, read case-insensitively by node.
 * @returns `true` when the request may proceed.
 */
export function isTrustedLocalRequest(headers: {
  host?: string | undefined
  origin?: string | undefined
  'sec-fetch-site'?: string | string[] | undefined
}): boolean {
  if (!hostIsLoopback(headers.host)) return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin.trim() !== '') return originIsLoopback(origin)
  const site = headers['sec-fetch-site']
  const value = Array.isArray(site) ? site[0] : site
  if (typeof value !== 'string') return true
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return true
  return !CROSS_SITE_FETCH_SITES.has(normalized)
}
