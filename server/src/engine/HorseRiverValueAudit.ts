/**
 * HORSE RIVER VALUE ALARM (Dan 2026-10-23)
 *
 * Two production hands (44826179, 44867615) showed a horse flat-calling the
 * exact river nuts when a raise was legal; a later sample showed horses
 * checking the river nuts 76 times in 30 minutes and leaving nut bets below
 * the full pot. The decision pipeline now forbids all of that
 * (HorseRiverNuts.riverNutsRaise / fullPotNearPotWager). This module is the
 * alarm that proves it keeps holding in production.
 *
 * It runs on every committed hand, from the settled snapshot only: each horse
 * action's captured public node (the controller's legal menu at that moment,
 * the public boards and every seat's public chips) plus the hand's dealt hole
 * cards. It never reads the decision state the policy saw, so a regression in
 * any policy owner, the worker transport or the commit-time executor is still
 * caught. It performs no database reads and never throws.
 *
 * A finding raises one durable engine alert (fire once, through the existing
 * alerts fleet) that names the hand, table, horse and what was wrong. The alert
 * resolves itself after a full day with audited horse river actions and no
 * further findings.
 */
import type { Card, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import { hasRiverNuts, riverNutWagerTarget } from './HorseRiverNuts.js';
import { raiseEngineAlert, resolveEngineAlert } from '../services/engineAlerts.js';

export type RiverValueFindingKind =
  | 'nut_call_with_legal_raise'
  | 'nut_check_with_legal_bet'
  | 'nut_wager_undersized'
  | 'near_pot_wager_not_full_pot';

export interface RiverValueFinding {
  kind: RiverValueFindingKind;
  seat: number;
  userId: string;
  street: string;
  action: string;
  amount: number | null;
  target: number | null;
}

export interface RiverValueAuditInput {
  variant: string;
  /** Dealt hole cards by user (engine memory, never persisted for mucked hands). */
  holeCards: ReadonlyMap<string, { seat?: number; cards: unknown }>;
  actions: ReadonlyArray<{
    seat: number;
    userId?: string;
    action: string;
    amount?: number;
    stage?: string;
    origin?: string;
    publicNode?: HorsePublicActionNode;
  }>;
  /** Table commitment cap, applied exactly as the commit-time executor does. */
  capEnabled?: boolean;
  capBb?: number;
  bigBlind?: number;
}

const SUIT: Record<string, Card['suit']> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
};
const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

function parseBoard(compact: string): Card[] | null {
  if (typeof compact !== 'string' || compact.length % 2 !== 0) return null;
  const out: Card[] = [];
  for (let i = 0; i < compact.length; i += 2) {
    const suit = SUIT[compact[i + 1]];
    if (!suit) return null;
    out.push({ rank: compact[i] as Card['rank'], suit });
  }
  return out;
}

function holeOf(input: RiverValueAuditInput, userId: string | undefined): Card[] | null {
  if (!userId) return null;
  const cards = input.holeCards.get(userId)?.cards;
  if (!Array.isArray(cards)) return null;
  const parsed: Card[] = [];
  for (const c of cards as Array<Partial<Card>>) {
    if (!c || typeof c.rank !== 'string' || typeof c.suit !== 'string') return null;
    parsed.push({ rank: c.rank as Card['rank'], suit: c.suit as Card['suit'] });
  }
  return parsed;
}

/** Pure audit of one committed hand. Exported for tests and offline replays. */
export function auditHorseRiverValue(input: RiverValueAuditInput): {
  findings: RiverValueFinding[];
  riverActionsAudited: number;
} {
  const findings: RiverValueFinding[] = [];
  let riverActionsAudited = 0;
  for (const a of input.actions) {
    const node = a.publicNode;
    if (a.origin !== 'horse_policy' || !node || node.status !== 'captured') continue;
    if (node.wagersCapped || node.actorSeat !== a.seat) continue;
    const self = node.seats.find((s) => s[0] === a.seat);
    if (!self) continue;
    const [, behind, streetWager, invested] = self;
    // Remaining table commitment, the same composition the executor applies.
    const capRoom =
      input.capEnabled === true && (input.capBb ?? 0) > 0 && (input.bigBlind ?? 0) > 0
        ? input.capBb! * input.bigBlind! - invested + streetWager
        : Infinity;
    const ceiling = Math.min(behind + streetWager, capRoom);
    const maxTo = node.maxRaiseTo === null ? null : Math.min(node.maxRaiseTo, ceiling + EPS);
    const amount = Number.isFinite(a.amount) ? (a.amount as number) : null;

    // ── 90-100% of pot is always the full pot when the full pot is legal ──
    if (
      (a.action === 'bet' || a.action === 'raise') &&
      node.structure !== 'fixed_limit' &&
      node.legalActions.includes(a.action as never) &&
      amount !== null &&
      node.pot > 0 &&
      node.minRaiseTo !== null &&
      maxTo !== null &&
      (a.action === 'raise' || node.currentBet === 0)
    ) {
      const base = a.action === 'bet' ? 0 : node.currentBet;
      const increment = node.pot + (a.action === 'raise' ? node.toCall : 0);
      const target = round2(base + increment);
      if (
        amount - base >= increment * 0.9 - 0.000001 &&
        amount < target - EPS &&
        target >= node.minRaiseTo &&
        target <= maxTo + 0.000001
      )
        findings.push(finding('near_pot_wager_not_full_pot', a, node.street, amount, target));
    }

    // ── River nuts: never passive, never under-sized ──
    if (node.street !== 'river') continue;
    const opponentCanAct = node.seats.some((s) => s[0] !== a.seat && !(s[6] & 7) && s[1] > 0);
    if (!opponentCanAct) continue;
    const hole = holeOf(input, a.userId);
    const boards = node.boards.map(parseBoard);
    if (!hole || boards.some((b) => !b || b.length !== 5)) continue;
    riverActionsAudited++;
    const hero = {
      seat: a.seat,
      cards: hole,
      stack: behind,
      bet: streetWager,
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    } as unknown as SeatPlayer;
    const state = {
      stage: 'river',
      gameVariant: node.variant ?? input.variant,
      communityCards: boards[0]!,
      communityCards2: boards[1] ?? undefined,
      communityCards3: boards[2] ?? undefined,
      boardCount: node.boardCount,
      pot: node.pot,
      currentBet: node.currentBet,
      toCall: node.toCall,
      minRaiseTo: node.minRaiseTo,
      maxRaiseTo: maxTo === null ? null : Math.min(maxTo, behind + streetWager),
      bettingStructure: node.structure,
      legalActions: [...node.legalActions],
      players: [],
    } as unknown as HorseGameStateV2;
    let kind: RiverValueFindingKind | null = null;
    let target: number | null = null;
    if (node.toCall > 0) {
      if ((a.action === 'call' || a.action === 'fold') && node.legalActions.includes('raise')) {
        target = riverNutWagerTarget('raise', hero, state);
        if (target !== null && behind > node.toCall) kind = 'nut_call_with_legal_raise';
      } else if (a.action === 'raise' && amount !== null) {
        target = riverNutWagerTarget('raise', hero, state);
        if (target !== null && amount < target - EPS) kind = 'nut_wager_undersized';
      }
    } else if (node.legalActions.includes('bet')) {
      target = riverNutWagerTarget('bet', hero, state);
      if (target !== null) {
        if (a.action === 'check') kind = 'nut_check_with_legal_bet';
        else if (a.action === 'bet' && amount !== null && amount < target - EPS)
          kind = 'nut_wager_undersized';
      }
    }
    // Match the value rule: an unbeatable shared board does not create private value.
    if (kind && hasRiverNuts(hero, state, true))
      findings.push(finding(kind, a, 'river', amount, target));
  }
  return { findings, riverActionsAudited };
}

function finding(
  kind: RiverValueFindingKind,
  a: RiverValueAuditInput['actions'][number],
  street: string,
  amount: number | null,
  target: number | null
): RiverValueFinding {
  return {
    kind,
    seat: a.seat,
    userId: a.userId ?? '',
    street,
    action: a.action,
    amount,
    target,
  };
}

// ── Alarm state (process-wide; one alert per fingerprint) ──────────────────
export const RIVER_VALUE_ALERT = 'HorseRiverValueLeak';
export const RIVER_VALUE_COMPONENT = 'horse_policy';
const QUIET_RESOLVE_MS = 24 * 60 * 60 * 1000;

const alarm = {
  firing: false,
  lastFindingAt: 0,
  findingsTotal: 0,
  riverActionsAudited: 0,
  handsAudited: 0,
};

export function horseRiverValueAlarmSnapshot() {
  return { ...alarm };
}

export function __resetHorseRiverValueAlarm(): void {
  Object.assign(alarm, {
    firing: false,
    lastFindingAt: 0,
    findingsTotal: 0,
    riverActionsAudited: 0,
    handsAudited: 0,
  });
}

/** Audit a committed hand and drive the alert. Never throws, never blocks. */
export function observeCommittedHandRiverValue(
  ctx: { tableId: string; handNumber: number },
  input: RiverValueAuditInput,
  now = Date.now()
): RiverValueFinding[] {
  try {
    const { findings, riverActionsAudited } = auditHorseRiverValue(input);
    alarm.handsAudited++;
    alarm.riverActionsAudited += riverActionsAudited;
    if (findings.length > 0) {
      alarm.findingsTotal += findings.length;
      alarm.lastFindingAt = now;
      const f = findings[0];
      console.warn(
        `[HorseRiverValue] ${f.kind} hand=${ctx.handNumber} table=${ctx.tableId} seat=${f.seat} action=${f.action} amount=${f.amount} target=${f.target}`
      );
      if (!alarm.firing) {
        alarm.firing = true;
        void raiseEngineAlert({
          alertname: RIVER_VALUE_ALERT,
          severity: 'warning',
          component: RIVER_VALUE_COMPONENT,
          summary: `Horse river value leak: ${f.kind} on hand ${ctx.handNumber}`,
          description:
            `A horse ${f.action} on the ${f.street} (amount ${f.amount ?? 'none'}, ` +
            `required ${f.target ?? 'n/a'}) at table ${ctx.tableId}, hand ${ctx.handNumber}, ` +
            `seat ${f.seat}. Rules: the exact river nuts always bet or raise to the full legal ` +
            `size when an opponent can act, and a 90-99% pot wager is always the full pot.`,
          labels: {
            kind: f.kind,
            table_id: ctx.tableId,
            hand_number: String(ctx.handNumber),
            user_id: f.userId,
          },
        }).catch(() => undefined);
      }
    } else if (
      alarm.firing &&
      riverActionsAudited > 0 &&
      now - alarm.lastFindingAt >= QUIET_RESOLVE_MS
    ) {
      alarm.firing = false;
      void resolveEngineAlert(
        RIVER_VALUE_ALERT,
        RIVER_VALUE_COMPONENT,
        'No horse river value leaks for a full day'
      ).catch(() => undefined);
    }
    return findings;
  } catch (err) {
    try {
      console.warn('[HorseRiverValue] audit skipped', err);
    } catch {
      /* never throw */
    }
    return [];
  }
}
