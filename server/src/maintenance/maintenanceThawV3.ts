/** Exact runtime client for the deployed v3 maintenance thaw contract. */
export interface MaintenanceThawRequest {
  announcedAt: number;
  freezeStartedAt: number;
  frozenSeconds: number;
  ownershipToken: string;
  thawedBy?: string;
}
export interface MaintenanceThawRelease {
  announcedAt: number;
  freezeStartedAt: number;
  ownershipToken: string;
  creditedThroughAt: number;
  effectiveFrozenSeconds: number;
}
export interface MaintenanceThawRpcArgs {
  p_announced_at: string;
  p_freeze_started: string;
  p_frozen_seconds: number;
  p_ownership_token: string;
  p_thawed_by: string | null;
}
export class MaintenanceThawError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'MaintenanceThawError';
  }
}
export const MAINTENANCE_THAW_STEPS = [
  'sit_out_at',
  'hold_expires_at',
  'addon_period_ends_at',
  'reversible_until',
  'reveal_deadline_at',
  'rebuy_prompt_until',
  'bomb_pot_next_due_at',
  'cash_stay_last_tick_at',
  'cash_rejoin_expires_at',
  'level_started_at',
  'cluster_break_eligible_since',
  'cluster_move_expires_at',
  'reconnect_presence',
  'reconnect_snapshots',
] as const;
function current(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('Maintenance thaw lifecycle ended');
}
/** A stop cancels the delay immediately, so teardown never joins a dead timer. */
export function waitForMaintenanceThaw(ms: number, signal: AbortSignal): Promise<void> {
  current(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Maintenance thaw lifecycle ended'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
function sameToken(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}
/** Also checked by the pause owner: a void callback is never release authority. */
export function assertMaintenanceThawRelease(
  request: MaintenanceThawRequest,
  release: MaintenanceThawRelease
): void {
  if (
    !release ||
    release.announcedAt !== request.announcedAt ||
    release.freezeStartedAt !== request.freezeStartedAt ||
    !sameToken(release.ownershipToken, request.ownershipToken) ||
    !Number.isFinite(release.creditedThroughAt) ||
    !Number.isFinite(release.effectiveFrozenSeconds) ||
    release.creditedThroughAt <= request.freezeStartedAt ||
    release.effectiveFrozenSeconds <= 0 ||
    Math.abs(
      (release.creditedThroughAt - request.freezeStartedAt) / 1000 - release.effectiveFrozenSeconds
    ) > 0.002
  ) {
    throw new MaintenanceThawError('maintenance_thaw_release_receipt_invalid', false);
  }
}
export interface MaintenanceThawOptions {
  signal: AbortSignal;
  maxCalls?: number;
  maxConsecutiveErrors?: number;
  pauseMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}
/**
 * Each retry carries the same immutable five arguments. A lost response can
 * recover only that owner's receipt. A bounded attempt may be retried by its
 * still-current maintenance owner; explicit SQL refusals never fall back to
 * the old three-argument bridge or authorize a row clear.
 */
export async function runMaintenanceThawV3(
  request: MaintenanceThawRequest,
  call: (args: Readonly<MaintenanceThawRpcArgs>) => Promise<unknown>,
  options: MaintenanceThawOptions
): Promise<MaintenanceThawRelease> {
  const { signal } = options;
  current(signal);
  if (
    !Number.isFinite(request.announcedAt) ||
    !Number.isFinite(request.freezeStartedAt) ||
    request.freezeStartedAt < request.announcedAt ||
    !request.ownershipToken ||
    !Number.isFinite(request.frozenSeconds) ||
    request.frozenSeconds <= 0
  ) {
    throw new MaintenanceThawError('maintenance_thaw_request_identity_invalid', false);
  }
  const args = Object.freeze({
    p_announced_at: new Date(request.announcedAt).toISOString(),
    p_freeze_started: new Date(request.freezeStartedAt).toISOString(),
    p_frozen_seconds: request.frozenSeconds,
    p_ownership_token: request.ownershipToken,
    p_thawed_by: request.thawedBy ?? null,
  });
  const sleep = options.sleep ?? waitForMaintenanceThaw;
  const pause = options.pauseMs ?? 250;
  let consecutiveErrors = 0;
  for (let index = 0; index < (options.maxCalls ?? 12); index++) {
    current(signal);
    let raw: unknown;
    try {
      raw = await call(args);
      current(signal);
      consecutiveErrors = 0;
    } catch (error) {
      current(signal);
      consecutiveErrors++;
      if (consecutiveErrors >= (options.maxConsecutiveErrors ?? 3)) {
        throw new MaintenanceThawError(
          `maintenance_thaw_transport_retry_pending: ${String(error)}`,
          true
        );
      }
      await sleep(pause, signal);
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new MaintenanceThawError('maintenance_thaw_response_invalid', false);
    }
    const result = raw as Record<string, unknown>;
    if (result.ok !== true) {
      throw new MaintenanceThawError(
        `maintenance_thaw_refused: ${String(result.reason ?? 'unknown')}`,
        false
      );
    }
    if (
      Date.parse(String(result.freeze_started_at)) !== request.freezeStartedAt ||
      !sameToken(result.ownership_token, request.ownershipToken)
    ) {
      throw new MaintenanceThawError('maintenance_thaw_response_identity_mismatch', false);
    }
    options.log?.(`[MaintenanceBreak] v3 thaw call ${index + 1}: ${String(result.reason)}`);
    if (result.complete === true) {
      const shifted = result.shifted as Record<string, unknown> | null;
      if (
        result.released !== true ||
        result.abandoned !== false ||
        result.retryable !== false ||
        !['thaw_complete_release_scheduled', 'release_receipt_recovered'].includes(
          String(result.reason)
        ) ||
        !shifted ||
        shifted.complete !== true ||
        !MAINTENANCE_THAW_STEPS.every((step) => Object.hasOwn(shifted, step))
      ) {
        throw new MaintenanceThawError('maintenance_thaw_release_certificate_incomplete', false);
      }
      const release: MaintenanceThawRelease = {
        announcedAt: request.announcedAt,
        freezeStartedAt: request.freezeStartedAt,
        ownershipToken: request.ownershipToken,
        creditedThroughAt: Date.parse(String(result.credited_through_at)),
        effectiveFrozenSeconds: Number(result.effective_frozen_seconds),
      };
      assertMaintenanceThawRelease(request, release);
      return Object.freeze(release);
    }
    if (
      result.complete !== false ||
      result.released !== false ||
      result.retryable !== true ||
      ![
        'maintenance_break_not_due',
        'thaw_checkpointed',
        'release_boundary_planned',
        'thaw_tail_checkpointed',
        'release_boundary_rebased',
      ].includes(String(result.reason)) ||
      !Number.isFinite(Number(result.retry_after_ms)) ||
      Number(result.retry_after_ms) < 0
    ) {
      throw new MaintenanceThawError('maintenance_thaw_partial_response_invalid', false);
    }
    await sleep(Math.max(pause, Number(result.retry_after_ms)), signal);
  }
  throw new MaintenanceThawError('maintenance_thaw_installments_retry_pending', true);
}
