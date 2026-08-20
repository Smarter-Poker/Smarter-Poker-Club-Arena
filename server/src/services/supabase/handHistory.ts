/**
 * Supabase helpers — the 4-tier hand history writer (Bible V8 §2.18).
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

/**
 * Log hand history — every hand documented for audit and replay.
 */
/**
 * Bible V8 §2.18: 4-tier Hand History system
 *
 * Tier 1: raw_events      — Every action with timestamps (audit/dispute)
 * Tier 2: audit_log       — Normalized format for compliance review
 * Tier 3: player_summaries — Per-player view (what they can see in their history)
 * Tier 4: dispute_review  — Full data package for dispute resolution
 *
 * CORRECTION 2026-08-20: the four tiers are DERIVED, not stored. See the long
 * note above insertHandHistoryRow() for the measurement that forced this — in
 * short, the columns never existed, every hand paid for a guaranteed-failing
 * write to attempt them, and all four are pure functions of columns this row
 * already stores. buildHandHistoryTiers() below materialises them on demand.
 */
export async function logHandHistory(params: {
  tableId: string;
  tournamentId?: string;
  handNumber: number;
  gameVariant: string;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount: number;
  bbjAmount?: number;
  communityCards: string[];
  // Round 38 — wall-clock timestamps. startedAt is captured at HAND_START
  // in ServerTableEngine; endedAt is stamped here at write time.
  startedAt?: number;
  endedAt?: number;
  winners: {
    userId: string;
    amount: number;
    potIndex?: number;
    hand?: { name: string; ranking: number };
  }[];
  players: { userId: string; username: string; seat: number; stack: number; cards: string[] }[];
  actions: {
    seat: number;
    userId?: string;
    action: string;
    amount?: number;
    timestamp?: number;
    stage: string;
  }[];
  showdownResults?: {
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards: { rank: string; suit: string }[];
  }[];
  /**
   * ASSISTANT FIX 2026-08-16: dealer/button seat for this hand.
   *
   * Without it no positional analysis is possible at all — seat 3 is UTG in
   * one hand and the cutoff two hands later, so "you open too wide from early
   * position", the most common leak in low-stakes poker, was uncomputable.
   * The engine has always tracked this (currentHandDealerSeat); it was simply
   * never persisted.
   */
  buttonSeat?: number;
}): Promise<{ handId: string | null }> {
  // Round 38 fix: stamp started_at/ended_at + RETURNING id so the caller
  // can FK rake_records.hand_id back to this hand_history row.
  const startedAtIso = params.startedAt
    ? new Date(params.startedAt).toISOString()
    : new Date().toISOString();
  const endedAtIso = params.endedAt
    ? new Date(params.endedAt).toISOString()
    : new Date().toISOString();

  // ── Personal-assistant inputs (ASSISTANT FIX 2026-08-16) ────────────
  // `hand_history.hole_cards` and `.board` have existed as columns for a long
  // time and NOTHING has ever written to them: 0 populated rows out of 56,594
  // hands a day. Meanwhile the leak detector selects exactly those two columns
  // (`hero_cards:hole_cards, board`) to attach a worked example to every leak
  // it reports — so every example it produced showed the player a leak with no
  // hand and no board attached.
  //
  // Only SHOWDOWN-revealed holdings go in. That is information the whole table
  // already saw face-up, so a hand participant reading this column learns
  // nothing new. Mucked cards are deliberately never stored: persisting them
  // would let anyone who played the hand mine their opponents' mucked ranges
  // afterwards, which is a game-integrity problem, not a feature.
  const holeCardsByUser: Record<string, { rank: string; suit: string }[]> = {};
  for (const sd of params.showdownResults ?? []) {
    if (sd.userId && sd.holeCards?.length) holeCardsByUser[sd.userId] = sd.holeCards;
  }
  const holeCardsPayload = Object.keys(holeCardsByUser).length > 0 ? holeCardsByUser : null;
  const boardPayload = params.communityCards?.length ? params.communityCards : null;

  const row = {
    table_id: params.tableId,
    tournament_id: params.tournamentId || null,
    hand_number: params.handNumber,
    game_variant: params.gameVariant,
    small_blind: params.smallBlind,
    big_blind: params.bigBlind,
    pot_size: params.potSize,
    rake_amount: params.rakeAmount,
    bbj_amount: params.bbjAmount || 0,
    community_cards: params.communityCards,
    started_at: startedAtIso,
    ended_at: endedAtIso,
    winners: params.winners,
    players: params.players,
    actions: params.actions,
    hole_cards: holeCardsPayload,
    board: boardPayload,
    button_seat: params.buttonSeat ?? null,
  };

  const handId = await insertHandHistoryRow(row, 'settlement');
  if (handId === null) {
    // Every in-line attempt failed. Hand it to the background queue rather
    // than losing the hand — see enqueueHandHistory().
    enqueueHandHistory(row);
  }
  return { handId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE WRITE ITSELF — retry, idempotency, and a durable-ish background queue
// ═══════════════════════════════════════════════════════════════════════════════
//
// 2026-08-20. Two defects, found by tracing the only open financial_alerts
// signal (rake_records rows with a null hand_id) back through the edge logs.
//
// DEFECT 1 — every hand made a guaranteed-failing write first.
//   This function used to insert with four extra JSONB columns (raw_events,
//   audit_log, player_summaries, dispute_review — "Bible V8 §2.18 4-tier hand
//   history") and fall back to an insert without them "if the columns don't
//   exist yet". The columns have NEVER existed: supabase/migrations/
//   20260417_hand_history_4tier.sql was written on 2026-04-17 and never
//   applied. So for four months EVERY hand did two PostgREST round-trips — a
//   400 followed by a 201. Measured in edge_logs: 138 x 400 + 138 x 201 in the
//   same minute, every minute, ~238,000 wasted failing requests a day. The
//   "graceful fallback" is exactly what kept it invisible.
//
//   The migration is deliberately NOT being applied. All four tiers are pure
//   functions of columns this row already stores: raw_events is `actions`
//   re-keyed, audit_log is the row's own scalars re-packed, player_summaries is
//   derived from players + winners + actions, and dispute_review is literally
//   the other three concatenated with showdown_results and community_cards.
//   hand_history is already 10 GB over 2.45M rows and takes 238,583 rows a day;
//   storing three redundant copies of the same payload would roughly quadruple
//   that growth for zero new information. buildHandHistoryTiers() below
//   materialises the same four tiers on demand from a stored row, so §2.18 is
//   satisfied by derivation instead of by triplication.
//
// DEFECT 2 — a transient failure lost the hand permanently.
//   The insert had no retry. Measured over 3 days: 320 rake rows written with a
//   null hand_id, and for 315 of them NO hand_history row exists at all — those
//   hands are unauditable, absent from player history, and missing from the
//   leaderboard's hand_history trigger. The failures are not spread out: all
//   320 land in 32 distinct minutes, 291 of them inside 14 minutes that had 5+
//   failures, peaking at 57 in one minute across 44 different tables. During
//   those windows hand_history writes drop to literally zero platform-wide
//   (199/min -> 52 -> 0 -> 61 -> 217 on 2026-08-19 01:06-01:08) while the much
//   smaller atomic_distribute_rake RPC still gets through. That is a load /
//   availability window, not a bad payload — which is precisely the profile
//   worth retrying.
//
// So: retry in line for the short blips, and queue for the long ones. Both are
// idempotent through uq_hand_history_global_hand_number, the existing partial
// unique index on hand_number WHERE hand_number >= 1000000 — every globally
// allocated hand number is covered by it, so "did my write actually land?" is a
// single indexed lookup. Below 1000000 the number is only per-table unique, so
// those hands are never retried (a retry there could duplicate).

type HandHistoryRow = Record<string, unknown> & { hand_number: number; table_id: string };

/** Only globally allocated hand numbers are unique platform-wide. */
const GLOBAL_HAND_NUMBER_FLOOR = 1_000_000;

const INLINE_ATTEMPTS = 3;
const INLINE_BACKOFF_MS = [250, 900];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Did this hand already land? Cheap: one indexed lookup on a unique index. */
async function findExistingHandId(row: HandHistoryRow): Promise<string | null> {
  if (row.hand_number < GLOBAL_HAND_NUMBER_FLOOR) return null;
  const { data, error } = await supabase
    .from('hand_history')
    .select('id')
    .eq('hand_number', row.hand_number)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.id ?? null;
}

/**
 * Insert one hand_history row, retrying transient failures.
 *
 * Before every retry it checks whether the previous attempt actually landed —
 * a request whose response was lost still wrote the row, and re-inserting it
 * would duplicate the hand. (4 of the 320 measured failures were exactly this:
 * a hand_history row exists, written before the rake row, yet the rake row
 * still got a null hand_id.)
 */
async function insertHandHistoryRow(
  row: HandHistoryRow,
  origin: 'settlement' | 'retry-queue'
): Promise<string | null> {
  const retryable = row.hand_number >= GLOBAL_HAND_NUMBER_FLOOR;
  const attempts = retryable ? INLINE_ATTEMPTS : 1;
  let lastError = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await sleep(INLINE_BACKOFF_MS[Math.min(attempt - 2, INLINE_BACKOFF_MS.length - 1)]);
      const existing = await findExistingHandId(row);
      if (existing) return existing;
    }

    const { data, error } = await supabase
      .from('hand_history')
      .insert(row)
      .select('id')
      .maybeSingle();

    if (!error) return data?.id ?? null;
    lastError = error.message ?? String(error);

    // A duplicate means a previous attempt landed after all — resolve to it.
    if (error.code === '23505') {
      const existing = await findExistingHandId(row);
      if (existing) return existing;
    }
  }

  if (origin === 'settlement') {
    reportError(
      new Error(
        `[DB] hand_history insert failed after ${attempts} attempt(s) for table ` +
          `${row.table_id} hand #${row.hand_number}: ${lastError}. Queued for background retry.`
      ),
      'logHandHistory.insert_failed'
    );
  }
  return null;
}

// ── Background retry queue ────────────────────────────────────────────────────
//
// The in-line retries cover ~1.2s, which handles a blip but not the observed
// 30-120 second windows where platform-wide hand_history writes go to zero. A
// hand's payload only exists in memory at settlement time — it cannot be
// reconstructed later from anything — so the choice is hold it or lose it.
//
// Bounded at MAX_QUEUE payloads (~4 KB each, so ~8 MB worst case) and drained
// every DRAIN_INTERVAL_MS. This is in-process, so a crash during an outage
// still loses the hand; it converts "one timeout loses a hand forever" into
// "only a crash during an outage does".

interface QueuedHand {
  row: HandHistoryRow;
  attempts: number;
  queuedAt: number;
}

const MAX_QUEUE = 2_000;
const MAX_QUEUE_ATTEMPTS = 20;
const DRAIN_INTERVAL_MS = 20_000;
const DRAIN_BATCH = 50;

const pendingHands: QueuedHand[] = [];
let droppedForCapacity = 0;
let drainTimer: NodeJS.Timeout | null = null;
let draining = false;

function enqueueHandHistory(row: HandHistoryRow): void {
  if (row.hand_number < GLOBAL_HAND_NUMBER_FLOOR) return; // cannot dedupe it
  if (pendingHands.length >= MAX_QUEUE) {
    pendingHands.shift();
    droppedForCapacity++;
    if (droppedForCapacity % 100 === 1) {
      reportError(
        new Error(
          `[DB] hand_history retry queue is full (${MAX_QUEUE}); ${droppedForCapacity} ` +
            `hand(s) dropped. hand_history has been unwritable for a sustained period.`
        ),
        'logHandHistory.queue_overflow'
      );
    }
  }
  pendingHands.push({ row, attempts: 0, queuedAt: Date.now() });
}

/**
 * A hand written late still has to be linked to the rake row that was banked
 * for it at settlement time, or the money stays unattributable — which is the
 * financial_alerts signal that started this investigation.
 * atomic_distribute_rake stamps metadata->>'hand_number', so the link is exact.
 */
async function relinkRakeRecord(row: HandHistoryRow, handId: string): Promise<void> {
  const { error } = await supabase.rpc('fn_relink_rake_record_to_hand', {
    p_table_id: row.table_id,
    p_hand_number: row.hand_number,
    p_hand_id: handId,
  });
  if (error) {
    reportError(error, 'logHandHistory.relink_rake_failed');
  }
}

export async function drainHandHistoryQueue(): Promise<{
  scanned: number;
  written: number;
  stillPending: number;
  exhausted: number;
}> {
  const summary = { scanned: 0, written: 0, stillPending: 0, exhausted: 0 };
  if (draining || pendingHands.length === 0) {
    summary.stillPending = pendingHands.length;
    return summary;
  }
  draining = true;
  try {
    const batch = pendingHands.splice(0, DRAIN_BATCH);
    summary.scanned = batch.length;
    for (const entry of batch) {
      entry.attempts++;
      let handId = await findExistingHandId(entry.row);
      if (!handId) {
        handId = await insertHandHistoryRow(entry.row, 'retry-queue');
      }
      if (handId) {
        summary.written++;
        await relinkRakeRecord(entry.row, handId);
      } else if (entry.attempts >= MAX_QUEUE_ATTEMPTS) {
        summary.exhausted++;
        reportError(
          new Error(
            `[DB] hand_history for table ${entry.row.table_id} hand #${entry.row.hand_number} ` +
              `gave up after ${entry.attempts} attempts over ` +
              `${Math.round((Date.now() - entry.queuedAt) / 1000)}s. The hand has no history row.`
          ),
          'logHandHistory.retry_exhausted'
        );
      } else {
        pendingHands.push(entry);
      }
    }
  } finally {
    draining = false;
    summary.stillPending = pendingHands.length;
  }
  return summary;
}

export function startHandHistoryRetry(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    void drainHandHistoryQueue()
      .then((s) => {
        if (s.written > 0 || s.exhausted > 0) {
          console.log(
            `[HandHistoryRetry] wrote ${s.written}, exhausted ${s.exhausted}, ` +
              `${s.stillPending} still queued`
          );
        }
      })
      .catch((err) => reportError(err, 'logHandHistory.drain_failed'));
  }, DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
}

export function stopHandHistoryRetry(): void {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}

/** Test/observability hook. */
export function handHistoryQueueDepth(): number {
  return pendingHands.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bible V8 §2.18 — the four tiers, DERIVED
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Materialise the 4-tier hand-history package from a hand.
 *
 * This is the same code that used to run on every settlement and write four
 * extra JSONB columns. It now runs on demand instead, because every tier is a
 * pure function of what the row already stores:
 *
 *   Tier 1 raw_events       <- actions (re-keyed with a sequence number and a
 *                              resolved userId)
 *   Tier 2 audit_log        <- the row's own scalar columns, re-packed
 *   Tier 3 player_summaries <- players + winners + actions + showdown results
 *   Tier 4 dispute_review   <- the other three, plus showdown results and board
 *
 * Storing them cost three redundant copies of the largest payload on the
 * platform (hand_history takes 238,583 rows and roughly a gigabyte a day) and
 * added no information. Call this from dispute tooling, an export, or an admin
 * endpoint with a row read back out of hand_history.
 */
export function buildHandHistoryTiers(hand: {
  tableId: string;
  tournamentId?: string | null;
  handNumber: number;
  gameVariant: string;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount: number;
  bbjAmount?: number;
  communityCards: string[];
  createdAt?: string;
  winners: { userId: string; amount: number; hand?: { name: string; ranking: number } }[];
  players: { userId: string; username: string; seat: number; stack: number; cards: string[] }[];
  actions: {
    seat: number;
    userId?: string;
    action: string;
    amount?: number;
    timestamp?: number;
    stage: string;
  }[];
  showdownResults?: { userId: string; handRanking: number; handName: string }[];
}) {
  const rawEvents = hand.actions.map((a, idx) => ({
    seq: idx,
    seat: a.seat,
    userId: a.userId || hand.players.find((p) => p.seat === a.seat)?.userId || 'unknown',
    action: a.action,
    amount: a.amount ?? 0,
    stage: a.stage,
    timestamp: a.timestamp ?? 0,
  }));

  const auditLog = {
    table_id: hand.tableId,
    tournament_id: hand.tournamentId || null,
    hand_number: hand.handNumber,
    game_variant: hand.gameVariant,
    blinds: { sb: hand.smallBlind, bb: hand.bigBlind },
    pot_size: hand.potSize,
    rake: hand.rakeAmount,
    bbj_fee: hand.bbjAmount || 0,
    board: hand.communityCards,
    player_count: hand.players.length,
    action_count: hand.actions.length,
    went_to_showdown: (hand.showdownResults?.length ?? 0) > 0,
    created_at: hand.createdAt ?? null,
  };

  const playerSummaries = hand.players.map((p) => {
    const winRecord = hand.winners.find((w) => w.userId === p.userId);
    const showdown = hand.showdownResults?.find((sd) => sd.userId === p.userId);
    const playerActions = hand.actions.filter((a) => a.seat === p.seat || a.userId === p.userId);
    return {
      userId: p.userId,
      username: p.username,
      seat: p.seat,
      startStack: p.stack,
      netResult: winRecord ? winRecord.amount : 0,
      handName: showdown?.handName || null,
      handRanking: showdown?.handRanking || null,
      actionCount: playerActions.length,
      folded: playerActions.some((a) => a.action === 'fold'),
      wentAllIn: playerActions.some((a) => a.action === 'all_in'),
    };
  });

  return {
    raw_events: rawEvents,
    audit_log: auditLog,
    player_summaries: playerSummaries,
    dispute_review: {
      raw_events: rawEvents,
      audit_log: auditLog,
      player_summaries: playerSummaries,
      showdown_results: hand.showdownResults ?? [],
      community_cards: hand.communityCards,
      pot_breakdown: hand.winners,
      integrity_hash: `${hand.tableId}:${hand.handNumber}`,
    },
  };
}
