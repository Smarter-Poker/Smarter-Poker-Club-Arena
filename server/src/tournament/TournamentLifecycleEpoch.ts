/**
 * A tournament manager is a generation, not merely a boolean.
 *
 * `running = false` cannot fence an async continuation: a stopped start/resume
 * can return from an awaited database call after a replacement manager has
 * already been installed and continue creating tables, arming timers, or
 * publishing state.  A token from this class identifies one exact manager
 * lifecycle.  Stop aborts and advances the generation synchronously, so every
 * continuation and delayed callback can prove it still belongs to the live
 * generation before it mutates anything.
 */
export interface TournamentLifecycleToken {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export class TournamentLifecycleAbortedError extends Error {
  constructor(readonly generation: number) {
    super(`Tournament lifecycle generation ${generation} is no longer current`);
    this.name = 'TournamentLifecycleAbortedError';
  }
}

export class TournamentLifecycleEpoch {
  private generation = 0;
  private controller: AbortController | null = null;
  private token: TournamentLifecycleToken | null = null;

  begin(): TournamentLifecycleToken {
    // A second start on the same object is a replacement generation too.  The
    // old signal is cancelled before the new token can become observable.
    this.controller?.abort();
    const controller = new AbortController();
    const token = Object.freeze({
      generation: ++this.generation,
      signal: controller.signal,
    });
    this.controller = controller;
    this.token = token;
    return token;
  }

  current(): TournamentLifecycleToken | null {
    return this.token;
  }

  isCurrent(token: TournamentLifecycleToken | null | undefined): boolean {
    return Boolean(
      token && this.token === token && token.generation === this.generation && !token.signal.aborted
    );
  }

  assertCurrent(token: TournamentLifecycleToken): void {
    if (!this.isCurrent(token)) throw new TournamentLifecycleAbortedError(token.generation);
  }

  abort(): void {
    this.controller?.abort();
    this.controller = null;
    this.token = null;
    // Advance even when abort() is repeated. A token can therefore never
    // become current again through integer reuse or a later begin().
    this.generation++;
  }
}
