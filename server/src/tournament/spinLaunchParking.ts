/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REFUSAL THAT CANNOT CHANGE IS NOT RETRIED EVERY SECOND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-09-10 (C-stuck-spins): fn_spin_draw_and_settle_atomic refused
 * every Spin launch with `projected_spin_draw_has_no_funding_proof` because
 * tournaments.spin_multiplier carried its column DEFAULT 0. The engine treated
 * that answer exactly like a lost lease: three RPC calls 250/500 ms apart, then
 * `running = false`, and one second later discoverSeatFirstStarts stopped the
 * dead manager and started a fresh one. 106 boards x 3 calls / ~3.6 s = ~87
 * calls a second, for hours: 163,460 calls and 1,347 s of database CPU on an
 * answer that could not change until a migration changed it.
 *
 * The database says WHY it refused. Its reasons fall into two kinds:
 *
 *   TERMINAL  - deterministic for the launch state as it stands (the row's
 *               contract, the roster, the escrow, the manifest). Asking again
 *               in 250 ms is asking the same question of the same rows. The
 *               tournament is PARKED: the fast lane leaves it alone for a
 *               window that starts at 30 s and doubles to a 15-minute cap,
 *               ONE financial alert is raised per tournament and reason, and
 *               one warning is logged. The park clears the moment the
 *               authority answers ok.
 *
 *   TRANSIENT - the lease, the receipt state or the maintenance freeze; these
 *               do change on their own. Today's in-attempt retry is kept
 *               (three tries, 250/500 ms), but the manager restart cadence
 *               backs off too (5 s, doubling, same cap) so that no reason of
 *               any kind can drive more than one call a second at a
 *               tournament.
 *
 * Nothing here moves money and nothing here cancels a game. Parking plus an
 * operator-visible alert is the whole action (CLAUDE.md 10.9): a game whose
 * launch the authority refuses is a game somebody has to look at, and the
 * loop that was hammering it was the one thing hiding that.
 *
 * The registry is in-process. An engine restart forgets every park, which is
 * harmless: the worst case is one fresh attempt per tournament at boot, after
 * which the schedule resumes from its first step.
 */

/** Refusals of fn_spin_draw_and_settle_atomic that only a data change can lift. */
export const SPIN_DRAW_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  // Engine passed a null id/launch/generation; the same call repeats it.
  'invalid_launch_request',
  // The row is not a 3-seat, fee-free Spin with a positive buy-in.
  'invalid_spin_contract',
  // Not exactly three paid identities in registered/playing.
  'spin_field_unproven',
  // Escrow row missing, unenforced, or gross_in disagrees with the wallets.
  'spin_entry_escrow_unproven',
  // A player's wallet debit and refund entitlement do not prove the buy-in.
  'spin_paid_entry_unproven',
  // A receipt exists for a different launch or a different roster.
  'spin_receipt_roster_mismatch',
  // A pre-cutover draw exists but the row does not carry a matching contract.
  'legacy_spin_rules_unproven',
  // spin_multiplier is projected (> 0) with no funded jackpot_draw behind it.
  'projected_spin_draw_has_no_funding_proof',
  // The engine's own manifest failed the authority's rule validation.
  'spin_rule_manifest_invalid',
]);

/** Refusals that resolve on their own: retry inside the attempt, as before. */
export const SPIN_DRAW_TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  'launch_lease_lost',
  'launch_receipt_state_mismatch',
  'entry_purchases_frozen',
]);

export type SpinDrawRefusalKind = 'terminal' | 'transient';

/**
 * Classify a refusal reason. Anything not in the terminal set is transient,
 * including transport errors and reasons this file has never heard of: an
 * unknown answer is retried the way it always was, and the restart backoff
 * still bounds it.
 */
export function classifySpinDrawRefusal(reason: string | null | undefined): SpinDrawRefusalKind {
  return typeof reason === 'string' && SPIN_DRAW_TERMINAL_REASONS.has(reason)
    ? 'terminal'
    : 'transient';
}

/** First park after a terminal refusal. */
export const SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS = 30_000;
/** First park after three transient refusals in one attempt. */
export const SPIN_LAUNCH_TRANSIENT_PARK_FIRST_MS = 5_000;
/** No park is longer than this, whatever the strike count. */
export const SPIN_LAUNCH_PARK_CAP_MS = 15 * 60_000;
/** Jitter takes up to this fraction OFF the step, so a park never exceeds the cap. */
export const SPIN_LAUNCH_PARK_JITTER = 0.2;
/** A park entry nobody has touched for this long is forgotten (strikes reset). */
export const SPIN_LAUNCH_PARK_FORGET_MS = 2 * SPIN_LAUNCH_PARK_CAP_MS;

/**
 * The park length for the Nth consecutive strike: first step doubled per
 * strike, clamped to the cap, then shortened by up to 20 percent so that a
 * board of parked tournaments does not wake in one wave.
 */
export function spinLaunchParkMs(
  strikes: number,
  kind: SpinDrawRefusalKind,
  random: () => number = Math.random
): number {
  const first =
    kind === 'terminal' ? SPIN_LAUNCH_TERMINAL_PARK_FIRST_MS : SPIN_LAUNCH_TRANSIENT_PARK_FIRST_MS;
  const exponent = Math.max(0, Math.min(30, Math.floor(strikes) - 1));
  const base = Math.min(SPIN_LAUNCH_PARK_CAP_MS, first * 2 ** exponent);
  const r = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(base - base * SPIN_LAUNCH_PARK_JITTER * r);
}

export interface SpinLaunchPark {
  tournamentId: string;
  reason: string;
  kind: SpinDrawRefusalKind;
  /** Consecutive failed launch attempts since the last ok. */
  strikes: number;
  /** Epoch ms until which the fast lane must not start this tournament. */
  until: number;
  /** When this entry was last written (epoch ms). */
  at: number;
  /** The reason the one financial alert was raised for, if any. */
  alertedReason: string | null;
}

export interface SpinLaunchParkOutcome {
  park: SpinLaunchPark;
  /** True the first time THIS reason parks THIS tournament in the streak. */
  firstForReason: boolean;
}

export class SpinLaunchParkRegistry {
  private readonly parks = new Map<string, SpinLaunchPark>();

  /** True while `now` is inside the tournament's park window. */
  isParked(tournamentId: string, now: number = Date.now()): boolean {
    const park = this.parks.get(tournamentId);
    return !!park && park.until > now;
  }

  /** Epoch ms the park ends, or null when not parked. */
  parkedUntil(tournamentId: string, now: number = Date.now()): number | null {
    const park = this.parks.get(tournamentId);
    return park && park.until > now ? park.until : null;
  }

  get(tournamentId: string): SpinLaunchPark | null {
    return this.parks.get(tournamentId) ?? null;
  }

  /**
   * Record one failed launch attempt and compute its park window. Strikes
   * accumulate across parks until `clear` (an ok from the authority) or until
   * the entry has been idle long enough to forget.
   */
  park(
    tournamentId: string,
    reason: string,
    kind: SpinDrawRefusalKind,
    now: number = Date.now(),
    random: () => number = Math.random
  ): SpinLaunchParkOutcome {
    this.forgetIdle(now);
    const previous = this.parks.get(tournamentId);
    const strikes = (previous?.strikes ?? 0) + 1;
    const until = now + spinLaunchParkMs(strikes, kind, random);
    const firstForReason = !previous || previous.reason !== reason;
    const park: SpinLaunchPark = {
      tournamentId,
      reason,
      kind,
      strikes,
      until,
      at: now,
      alertedReason: previous?.alertedReason ?? null,
    };
    this.parks.set(tournamentId, park);
    return { park, firstForReason };
  }

  /**
   * Has the one alert for this tournament + reason already gone out? Marks it
   * so on the first call, so a caller that raises when this returns true
   * raises exactly once per reason per streak.
   */
  claimAlert(tournamentId: string, reason: string): boolean {
    const park = this.parks.get(tournamentId);
    if (!park) return false;
    if (park.alertedReason === reason) return false;
    park.alertedReason = reason;
    return true;
  }

  /** The authority answered ok: the streak is over. */
  clear(tournamentId: string): boolean {
    return this.parks.delete(tournamentId);
  }

  /** Every tournament currently inside a park window. */
  snapshot(now: number = Date.now()): SpinLaunchPark[] {
    const out: SpinLaunchPark[] = [];
    for (const park of this.parks.values()) if (park.until > now) out.push({ ...park });
    return out;
  }

  get size(): number {
    return this.parks.size;
  }

  private forgetIdle(now: number): void {
    for (const [id, park] of this.parks) {
      if (now - park.at > SPIN_LAUNCH_PARK_FORGET_MS && park.until <= now) this.parks.delete(id);
    }
  }
}

/** The process-wide registry the launch path and the fast lane share. */
export const spinLaunchParks = new SpinLaunchParkRegistry();

/** Source string of the one financial alert a parked launch raises. */
export const SPIN_LAUNCH_PARKED_ALERT_SOURCE = 'Tournament.spin_launch_parked';

export type SpinDrawRpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

export interface ProveSpinDrawDeps<T> {
  tournamentId: string;
  launchId: string;
  /** One call of fn_spin_draw_and_settle_atomic. */
  callDraw: () => PromiseLike<SpinDrawRpcResult>;
  /** Turn an ok payload into the typed receipt; throwing is a transient failure. */
  readReceipt: (data: unknown) => T;
  /** Throws the lifecycle abort error when the manager has been fenced. */
  assertLifecycleCurrent: () => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  parks?: SpinLaunchParkRegistry;
  raiseAlert: (
    severity: 'critical' | 'warning' | 'info',
    source: string,
    message: string,
    context: Record<string, unknown>
  ) => Promise<unknown>;
  warn: (message: string) => void;
  reportError: (error: Error, context: string, extra?: Record<string, unknown>) => void;
  /** Attempts inside one launch for a transient refusal. Default 3 (today's). */
  maxAttempts?: number;
  /** Sleep before attempt n+1 after a transient refusal. Default 250 * n (today's). */
  retryDelayMs?: (attempt: number) => number;
}

export type ProveSpinDrawResult<T> =
  | { ok: true; receipt: T; attempts: number }
  | {
      ok: false;
      reason: string;
      kind: SpinDrawRefusalKind;
      attempts: number;
      park: SpinLaunchPark;
    };

/**
 * The draw loop with its refusals classified.
 *
 * Terminal: one call, park, alert once, warn once. Transient: today's three
 * attempts with 250/500 ms between them, then park with the shorter schedule.
 * Ok: clear any park. Lifecycle aborts propagate untouched.
 */
export async function proveSpinDrawWithParking<T>(
  deps: ProveSpinDrawDeps<T>
): Promise<ProveSpinDrawResult<T>> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const parks = deps.parks ?? spinLaunchParks;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
  const retryDelayMs = deps.retryDelayMs ?? ((attempt: number) => 250 * attempt);

  let lastReason = 'spin_draw_receipt_unavailable';
  let kind: SpinDrawRefusalKind = 'transient';
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    let result: SpinDrawRpcResult;
    try {
      result = await deps.callDraw();
    } catch (err: any) {
      result = { data: null, error: { message: err?.message ? String(err.message) : String(err) } };
    }
    deps.assertLifecycleCurrent();

    const data = result.data as { ok?: unknown; reason?: unknown } | null | undefined;
    if (!result.error && data && data.ok === true) {
      let receipt: T;
      try {
        receipt = deps.readReceipt(data);
      } catch (err: any) {
        lastReason = err?.message ? String(err.message) : String(err);
        kind = 'transient';
        if (attempt < maxAttempts) {
          await deps.sleep(retryDelayMs(attempt));
          deps.assertLifecycleCurrent();
        }
        continue;
      }
      parks.clear(deps.tournamentId);
      return { ok: true, receipt, attempts };
    }

    if (result.error) {
      lastReason = result.error.message ? String(result.error.message) : 'spin_draw_rpc_error';
      kind = 'transient';
    } else {
      lastReason =
        typeof data?.reason === 'string' && data.reason.length > 0
          ? data.reason
          : 'spin_draw_receipt_unavailable';
      kind = classifySpinDrawRefusal(lastReason);
    }

    if (kind === 'terminal') break;
    if (attempt < maxAttempts) {
      await deps.sleep(retryDelayMs(attempt));
      deps.assertLifecycleCurrent();
    }
  }

  const { park, firstForReason } = parks.park(deps.tournamentId, lastReason, kind, now(), random);
  const short = deps.tournamentId.slice(0, 8);
  const untilIso = new Date(park.until).toISOString();
  const parkS = Math.round((park.until - now()) / 1000);

  if (kind === 'terminal') {
    if (firstForReason) {
      deps.warn(
        `[Tournament:${short}] Spin launch parked: the atomic authority refused with ${lastReason}, a reason that cannot change until the tournament's data does. No retry until ${untilIso} (${parkS}s, strike ${park.strikes}); one financial alert raised.`
      );
      deps.reportError(
        new Error(
          `[Tournament:${short}] Immutable funded Spin receipt refused with terminal reason ${lastReason} - parked until ${untilIso} instead of retrying`
        ),
        'Tournament.spin_draw_refused_terminal',
        { tournamentId: deps.tournamentId, reason: lastReason, parkedUntil: untilIso }
      );
    }
    if (parks.claimAlert(deps.tournamentId, lastReason)) {
      await deps.raiseAlert(
        'critical',
        SPIN_LAUNCH_PARKED_ALERT_SOURCE,
        `Spin ${short} cannot launch: fn_spin_draw_and_settle_atomic refused with ${lastReason}. Three paid seats are waiting; the engine has parked the launch and will not retry faster than its backoff.`,
        {
          tournament_id: deps.tournamentId,
          launch_id: deps.launchId,
          reason: lastReason,
          strikes: park.strikes,
          parked_until: untilIso,
        }
      );
    }
  } else {
    deps.reportError(
      new Error(
        `[Tournament:${short}] Immutable funded Spin receipt was not proven after ${attempts} attempts (${lastReason}) - standing down before reveal and RUNNING; the next attempt waits ${parkS}s (strike ${park.strikes}) and replays the same database authority`
      ),
      'Tournament.spin_draw_unavailable',
      { tournamentId: deps.tournamentId, reason: lastReason, parkedUntil: untilIso }
    );
  }

  return { ok: false, reason: lastReason, kind, attempts, park };
}
