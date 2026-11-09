/**
 * Published description of the loopback shim, for external OpenAI-compatible
 * clients (a chat bot, an editor, another agent host).
 *
 * The shim itself is private by construction: it binds a random loopback port
 * and authenticates with a per-process secret that only lives in memory. That
 * is the right default — nothing outside this process can use the provider —
 * but it also means a second local program cannot discover it.
 *
 * When the operator pins `shimPort`, the plugin writes this file so such a
 * client can pick the endpoint up: the base URL, the bearer to send, and the
 * model ids the account currently serves. The file is created with mode 0600
 * because the bearer is a live credential for the configured CodeBuddy account
 * — the client never sees the upstream token, only this shim-local secret.
 *
 * Written only when a fixed port is configured; the default (random port) is
 * deliberately invisible, so an untouched install publishes nothing.
 *
 * @module dsh-codebuddy-cli/shim-endpoint
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Basename of the endpoint file inside the Harness home. */
export const CODEBUDDY_SHIM_ENDPOINT_FILENAME = '.codebuddy-shim-endpoint.json'

/** Current on-disk format; readers reject others. */
const ENDPOINT_FORMAT_VERSION = 1

/** What the plugin publishes about the running shim. */
export interface CodeBuddyShimEndpoint {
  version: typeof ENDPOINT_FORMAT_VERSION
  package: 'dsh-codebuddy-cli'
  /** Host PID, so a stale file after a crash can be told apart from a live one. */
  pid: number
  /** Epoch milliseconds when the file was written. */
  writtenAt: number
  /** Shim origin, e.g. `http://127.0.0.1:45871`. */
  baseUrl: string
  /**
   * OpenAI-compatible root to hand a client: `baseUrl` plus `/v1`, because
   * clients append `/chat/completions` themselves.
   */
  openaiBaseUrl: string
  /** Bearer the client must send; it is the shim's own secret, not the upstream token. */
  token: string
  /** Model ids served by the account right now. */
  models: readonly string[]
}

/** Absolute path of the endpoint file. */
export function codebuddyShimEndpointPath(): string {
  return join(resolveDshHome(), CODEBUDDY_SHIM_ENDPOINT_FILENAME)
}

/** Fields the plugin supplies; identity and timestamps are added here. */
export type CodeBuddyShimEndpointInput = Pick<CodeBuddyShimEndpoint, 'baseUrl' | 'openaiBaseUrl' | 'token' | 'models'>

/**
 * Write (or overwrite) the endpoint file.
 *
 * Throws on failure: unlike the heartbeat, a silently missing file means the
 * external client cannot connect at all, and the operator explicitly asked for
 * this by pinning a port — so the caller logs it rather than swallowing it.
 */
export async function writeShimEndpoint(input: CodeBuddyShimEndpointInput): Promise<void> {
  const document: CodeBuddyShimEndpoint = {
    version: ENDPOINT_FORMAT_VERSION,
    package: 'dsh-codebuddy-cli',
    pid: process.pid,
    writtenAt: Date.now(),
    ...input,
  }
  await writeFileAtomic(codebuddyShimEndpointPath(), `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
}

/** Remove the endpoint file on disposal; a stale one would advertise a dead port. */
export async function clearShimEndpoint(): Promise<void> {
  try {
    await rm(codebuddyShimEndpointPath(), { force: true })
  } catch {
    // Best-effort: the reader compares the PID and the port, so a leftover file
    // cannot be mistaken for a live endpoint.
  }
}
