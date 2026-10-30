import { HORSE_TOURNAMENT_REBUY_SHARE } from './horseTournamentRebuyChoice.js';

/** One scoped, single-line record from the original input path. No polling or money writes.
 * Deduplicate choice records by (tournamentId,userId,handNumber), never count retries as choices.
 * Unknown/transport outcomes are not declines or proof that no purchase committed.
 */
export interface HorseRebuyDecisionDiagnostic {
  tournamentId: string;
  userId: string;
  handNumber: number;
  choice: boolean;
  phase:
    | 'choice'
    | 'deferred'
    | 'expired'
    | 'capacity_deferred'
    | 'purchase_pending'
    | 'purchase_started'
    | 'purchased'
    | 'purchase_unproven';
  bustAtMs: number | null;
  promptUntilMs: number | null;
  startedAtMs?: number;
  dueAtMs?: number | null;
  error?: unknown;
}
export function horseRebuyFailureClass(error: unknown): string {
  const e =
    error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : {};
  const message = typeof e.message === 'string' ? e.message : '';
  if (/window has closed|period is closed|not accepting rebuys/i.test(message)) return 'cutoff';
  if (/insufficient|balance|fund/i.test(message)) return 'funding';
  if (/limit reached/i.test(message)) return 'limit';
  if (/generation|knockout/i.test(message)) return 'generation';
  if (/seat|chair/i.test(message)) return 'seat';
  if (/bounty/i.test(message)) return 'bounty';
  if (/frozen|maintenance/i.test(message)) return 'freeze';
  if (e.code === '57014' || /timeout|canceling statement/i.test(message)) return 'timeout';
  if (/fetch|network|transport/i.test(message)) return 'transport';
  return 'unknown';
}
export function reportHorseRebuyDecision(input: HorseRebuyDecisionDiagnostic): void {
  try {
    const { error, ...identity } = input;
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    const observedAtMs = Date.now();
    console.info(
      '[Tournament.horse_rebuy_decision] ' +
        JSON.stringify({
          schema: 'horse-rebuy-decision/v1',
          choiceShare: HORSE_TOURNAMENT_REBUY_SHARE,
          ...identity,
          observedAtMs,
          remainingMs: input.promptUntilMs === null ? null : input.promptUntilMs - observedAtMs,
          elapsedMs: input.startedAtMs === undefined ? null : observedAtMs - input.startedAtMs,
          sqlstate: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null,
          failureClass: input.phase === 'purchase_unproven' ? horseRebuyFailureClass(error) : null,
        })
    );
  } catch {
    /* Diagnostics cannot interrupt the original input. */
  }
}
