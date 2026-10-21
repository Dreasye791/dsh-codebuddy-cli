/**
 * Local type augmentation for the host event this plugin listens to.
 *
 * `agent/pre-step` is declared by `@deepseek-ai/dsh-agent`, which is not a
 * dependency of this plugin — the host supplies it at runtime, and adding it
 * here would only duplicate the host's own type surface. Declaring the one
 * event we use keeps `tsc` able to check the listener without that coupling.
 *
 * The shape is copied from the host's own listener (measured against DSH
 * 0.2.1-rc.2): a waterfall whose payload carries the loop's `step` counter,
 * which restarts at 1 for every turn.
 *
 * @module dsh-codebuddy-cli/pre-step-events
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Runs before each loop step; `step` is 1 for the first step of a turn.
     *
     * @mode waterfall
     */
    'agent/pre-step': (
      payload: {
        /** The agent whose loop is stepping; `agent.session.id` is the DSH session id. */
        agent: { session: { id: string } }
        /** Messages queued for this step, before listener additions. */
        messages: readonly unknown[]
        /** The turn's cancellation signal. */
        signal: AbortSignal
        /** 1-based step counter within the current turn. */
        step: number
      },
      next: () => Promise<{ kind: string; messages: readonly unknown[] }>,
    ) => Promise<{ kind: string; messages: readonly unknown[] }>
  }
}

export {}
