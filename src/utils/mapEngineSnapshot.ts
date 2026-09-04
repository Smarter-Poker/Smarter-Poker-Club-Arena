/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * mapEngineSnapshot — Engine snapshot → TablePage tableState shape
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Hetzner engine publishes state in the shape defined by
 * ServerTableEngine.broadcastCurrentState(): a flat object keyed by
 * table_id, pot, current_player (user_id), stage, dealer_seat,
 * action_history[], players[], etc.
 *
 * TablePage.tsx keeps local state in `tableState` shaped for rendering:
 * per-seat arrays indexed by (seatNumber - 1), pot, communityCards,
 * boardStage enum, currentPlayerSeat (number, not user_id), etc.
 *
 * This module is the single place that translates between the two. Keeping
 * it out of TablePage.tsx means the 5000-line page doesn't grow further and
 * the mapping is directly unit-testable.
 */

import type { EngineSnapshot } from '../services/EngineStateClient';
import { recordServerTime } from './serverClock';

// ─── Raw payload type (duplicated here, not imported, so a server shape tweak
// can't silently break the client at runtime; typos surface at compile time).
export interface EnginePublicPlayer {
  seat: number;
  user_id: string;
  username?: string;
  stack: number;
  bet?: number;
  totalInvested?: number;
  cards?: Array<{ rank: string; suit: string }>;
  is_folded?: boolean;
  is_all_in?: boolean;
  is_sitting_out?: boolean;
  is_disconnected?: boolean;
  time_bank_remaining?: number;
  time_bank_uses_remaining?: number;
  position?: string;
  avatar_url?: string;
  /** Equipped avatar frame token, e.g. `frame-gold`. '' or absent means none. */
  equipped_frame?: string;
  /** Equipped avatar aura token, e.g. `aura-fire`. '' or absent means none. */
  equipped_aura?: string;
  is_horse?: boolean;
  hand_name?: string;
  /**
   * SHOWDOWN SYSTEM 2026-08-25: the engine ruled this hand muckable at
   * showdown and the player has not voluntarily shown — the seat renders a
   * MUCKED label instead of cards. Never inferred client-side.
   */
  is_mucked?: boolean;
  /**
   * CHIP CONTINUITY (2026-09-04): the stay clock. Money put onto this
   * session, the remaining stay time as of this snapshot, whether it is
   * counting down, and whether leaving is refused right now. All three
   * engine payloads carry them; the client renders and never decides.
   */
  session_baseline?: number;
  stay_remaining_ms?: number;
  stay_running?: boolean;
  leave_locked?: boolean;
}

export interface EngineActionRecord {
  seat: number;
  userId: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
  amount: number;
  timestamp: number;
  stage: string;
}

export type DisconnectFsmState = 'CONNECTED' | 'MISSING' | 'DISCONNECTED' | 'SAT_OUT';

export interface DisconnectFsmEntry {
  state: DisconnectFsmState;
  sinceMs: number;
  graceDeadlineMs: number | null;
}

export interface EnginePublishedState {
  table_id: string;
  hand_number: number;
  pot: number;
  community_cards: Array<{ rank: string; suit: string }>;
  /** DOUBLE-BOARD BOMB POT 2026-08-20: second board (empty unless active). */
  community_cards2?: Array<{ rank: string; suit: string }>;
  /** TRIPLE-BOARD BOMB POT 2026-08-27: third board (empty unless active). */
  community_cards3?: Array<{ rank: string; suit: string }>;
  /** ROUND 3 (2026-08-20): hands until the next bomb pot (1 = next hand); null = no bomb pots. */
  bomb_pot_in?: number | null;
  /** BOMB POT STANDARDIZATION 2026-08-27: timed mode — epoch ms when the next bomb is due. */
  bomb_pot_next_at?: number | null;
  /**
   * 2026-08-29: a bomb is due but the table is short of bomb_pot_min_players,
   * so the engine is holding it. The number is the floor it is waiting for.
   * Null when nothing is waiting. Absent on older engines.
   */
  bomb_pot_waiting_for?: number | null;
  /** VARIANT OVERRIDE 2026-08-28 (spec §10.1): the variant THIS hand is played as. */
  hand_variant?: string;
  current_bet: number;
  current_player: string | null; // user_id
  dealer_seat: number;
  stage: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'waiting';
  winner_ids?: string[];
  winners?: Array<{ user_id: string; amount: number }>;
  min_raise: number;
  last_raise: number;
  /**
   * 2026-08-23: the betting structure, published by the engine rather than
   * guessed from the variant string. See server/src/engine/BettingStructure.ts.
   * Optional so a snapshot from an older engine build still maps cleanly.
   */
  betting_structure?: 'no_limit' | 'pot_limit' | 'fixed_limit';
  /** Fixed limit only: the street's one legal wager (small bet or big bet). */
  fixed_bet_size?: number;
  /** Fixed limit only: bet and three raises are in — fold or call only. */
  wagers_capped?: boolean;
  turn_start_time_ms?: number;

  turn_duration_ms?: number;
  /** Phase 1.2 PR-F: absolute wall-clock deadline for the current turn. */
  turn_deadline_ms?: number;
  time_bank_active?: boolean;
  /** Engine wall clock at broadcast time. Lets the client correct for device
   *  clock drift when working out how much of a turn has elapsed. */
  server_time_ms?: number;
  /* PINEAPPLE DISCARD CLOCK (2026-08-31). Absolute epoch ms, server-authored.
     `discard_deadlines` is keyed by user_id - a seat that bought time with a
     time bank has its own, later, deadline. `discard_deadline_ms` is the round's
     unextended deadline and is what a seat that has already discarded sees.
     Both null outside the discard round, which is what stops a dead countdown
     lingering on the felt between hands. */
  discard_deadline_ms?: number | null;
  discard_deadlines?: Record<string, number>;
  discard_duration_ms?: number;
  /** Phase 1.2 PR-F: per-user disconnect FSM map for client UI. */
  disconnect_states?: Record<string, DisconnectFsmEntry>;
  // NOTE: `eligible` holds USER IDs (strings) as emitted by the engine's
  // calculatePots(); older/mocked payloads may carry seat numbers. The mapper
  // resolves both to seat numbers.
  pots: Array<{ amount: number; eligible: Array<string | number> }>;
  action_history: EngineActionRecord[];
  players: EnginePublicPlayer[];
}

// ─── Output: the fields we patch into TableState. Keeping this type open-ended
// (Partial<unknown>-shape) avoids importing the 20-field TableState type here.
export interface MappedTableStatePatch {
  pot: number;
  communityCards: Array<{ rank: string; suit: string }>;
  /** DOUBLE-BOARD BOMB POT 2026-08-20: second board (empty unless active). */
  communityCards2: Array<{ rank: string; suit: string }>;
  /** TRIPLE-BOARD BOMB POT 2026-08-27: third board (empty unless active). */
  communityCards3: Array<{ rank: string; suit: string }>;
  /** ROUND 3 (2026-08-20): hands until the next bomb pot; null = no bomb pots. */
  bombPotIn: number | null;
  /** BOMB POT STANDARDIZATION 2026-08-27: timed mode — epoch ms of the next due bomb. */
  bombPotNextAt: number | null;
  /**
   * 2026-08-29: seats a due-but-held bomb is waiting for, or null when nothing
   * is waiting. The felt used to promise BOMB POT NEXT HAND and then deal
   * ordinary hands indefinitely, with the reason available nowhere.
   */
  bombPotWaitingFor: number | null;
  /**
   * VARIANT OVERRIDE 2026-08-28 (spec §10.1): the variant THIS hand is played
   * as; null when the engine predates the field. Clients size villain
   * card-backs and evaluate winner highlights from it, falling back to the
   * table's own game.
   */
  handVariant: string | null;
  boardStage: string; // matches TableState['boardStage']
  dealerSeat: number;
  currentPlayerSeat: number;
  /** Per-seat last action (length maxPlayers, index = seat-1). */
  lastActions: Array<string | null>;
  /** Per-seat last bet amount (length maxPlayers, index = seat-1). */
  lastBetAmounts: number[];
  /** Per-seat position label ('BTN', 'SB', etc.) or null. */
  positions: Array<string | null>;
  /** Per-seat SeatPlayer-shape or null. */
  players: Array<{
    id: string;
    name: string;
    avatar?: string;
    /** Equipped avatar frame token. Drawn over `avatar` by AvatarCosmetics. */
    frame?: string;
    /** Equipped avatar aura token. Drawn under `avatar` by AvatarCosmetics. */
    aura?: string;
    stack: number;
    status: 'active' | 'folded' | 'all_in' | 'sitting_out' | 'away' | 'disconnected';
    holeCards?: Array<{ rank: string; suit: string }>;
    showCards: boolean;
    isHero: boolean;
    /** SHOWDOWN SYSTEM 2026-08-25: engine-decided muck — seat shows MUCKED. */
    isMucked?: boolean;
  } | null>;
  /** Current bet for action panel. */
  currentBet: number;
  minRaise: number;
  lastRaise: number;
  /**
   * 2026-08-23: which betting structure the action panel should draw — a
   * slider for no-limit and pot-limit, a single fixed-size button for limit.
   * Undefined on snapshots from an engine build that predates this field; the
   * panel then falls back to deriving it from the variant string.
   */
  bettingStructure?: 'no_limit' | 'pot_limit' | 'fixed_limit';
  /** Fixed limit only: the street's one legal wager. */
  fixedBetSize?: number;
  /** Fixed limit only: the round is capped — fold or call only. */
  wagersCapped?: boolean;

  /** For action timer. */
  actionTimerDeadline?: number;
  /** Hero's OWN pineapple discard deadline, absolute epoch ms. Null off-round. */
  discardDeadline?: number | null;
  /** How long the discard round runs, ms - the ring's full sweep. */
  discardDurationMs?: number;
  /** Server-authoritative turn start wall-clock (for CSS ring animation). */
  actionTimerStartTime?: number;
  actionTimerPlayerId?: string;
  isTimeBankActive?: boolean;
  /** hand number */
  handNumber: number;
  /** side pots */
  sidePots: Array<{ amount: number; eligibleSeats: number[] }>;
  /** Phase 1.2 PR-F: per-user disconnect FSM map for client toasts. */
  disconnectStates: Record<string, DisconnectFsmEntry>;
  /**
   * Phase 2 T1-01: winners of the current hand with net profit (winnings
   * minus their own contribution). Empty until stage === 'showdown' OR
   * end-of-hand broadcast. Drives the signature PokerBros +N yellow
   * floating text above each winner.
   */
  winners: Array<{ userId: string; seat: number; amount: number; netAmount: number }>;
  /**
   * Bible V8 §4.2 — User IDs of players who joined the table mid-hand and
   * are currently waiting for the BB to rotate to their seat. The hero
   * sees a "Post BB" button if their own userId is in this list. Walkthrough
   * Step 4 fix 2026-04-29 — previously the engine tracked this internally
   * but never exposed it to clients.
   */
  waitingForBBUserIds: string[];
  /**
   * Dan 2026-08-29 — the subset of waitingForBBUserIds who have ALREADY
   * agreed to post the big blind and are held out only by the seat they are
   * sitting in (the one the small blind or the button is about to reach).
   *
   * The hero must NOT be asked again while their own id is in here. That is
   * the entire bug: the engine refused the post positionally, the client had
   * no way to know the answer had been kept, and so it re-rendered the same
   * "Post Big Blind To Enter" button on the next snapshot and after every
   * reload. The engine replays the agreement itself once the seat clears.
   */
  postBBDeferredUserIds: string[];
  /**
   * How many seats this table has, as the MAPPER resolved it (phase 1,
   * 2026-08-31): the engine's published `max_seats` when present, otherwise
   * the highest occupied seat, never below the caller's own belief.
   *
   * It is the exact length of `players`, `positions`, `lastActions` and
   * `lastBetAmounts` above — published rather than left implicit so the page
   * can adopt it as `maxPlayers` and the seat ring, the geometry and these
   * arrays cannot drift apart again. Every one of them disagreeing with the
   * others is the shape of the seat-7 incident.
   */
  maxSeats: number;
  /**
   * CHIP CONTINUITY: the hero's own leave lock, as the engine published it.
   * `remainingMs` is as of `at` (engine clock, ms); the leave control counts
   * down from there while `running`. Null when the hero is not seated or the
   * engine build predates the field.
   */
  heroLeave: { locked: boolean; remainingMs: number; running: boolean; at: number } | null;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

const STATUS_FROM_PLAYER = (
  p: EnginePublicPlayer
): MappedTableStatePatch['players'][number] extends infer _ | null
  ? NonNullable<MappedTableStatePatch['players'][number]>['status']
  : never => {
  if (p.is_folded) return 'folded';
  if (p.is_all_in) return 'all_in';
  if (p.is_sitting_out) return 'sitting_out';
  if (p.is_disconnected) return 'disconnected';
  return 'active';
};

/**
 * Compute the most recent action + amount for each seat on the CURRENT STREET
 * only. When the street advances (preflop -> flop -> turn -> river) the engine
 * carries the full hand's action history forward, but the per-seat "last
 * action" label and "bet chips in front of seat" must represent the NEW
 * street only. Filtering by currentStage is what guarantees the turn bet
 * amount clears when the river begins (BUG 031 root cause).
 *
 * Folds are preserved across streets (a folded player stays folded for the
 * rest of the hand, so the FOLD label must remain visible).
 *
 * Returns two arrays indexed by seatNumber-1 (length maxSeats).
 */
function derivePerSeatLastAction(
  actionHistory: EngineActionRecord[],
  maxSeats: number,
  currentStage: string
): { lastActions: Array<string | null>; lastBetAmounts: number[] } {
  const lastActions: Array<string | null> = Array(maxSeats).fill(null);
  const lastBetAmounts: number[] = Array(maxSeats).fill(0);
  // First pass: record folds across the whole hand (they persist).
  for (const a of actionHistory) {
    const idx = a.seat - 1;
    if (idx < 0 || idx >= maxSeats) continue;
    if (a.action === 'fold') {
      lastActions[idx] = 'fold';
      lastBetAmounts[idx] = 0;
    }
  }
  // Second pass: only consider actions from the current street.
  for (const a of actionHistory) {
    const idx = a.seat - 1;
    if (idx < 0 || idx >= maxSeats) continue;
    if (a.stage !== currentStage) continue;
    // Don't overwrite a fold with a same-street (impossible but defensive).
    if (lastActions[idx] === 'fold' && a.action !== 'fold') continue;
    lastActions[idx] = a.action;
    if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') {
      lastBetAmounts[idx] = a.amount;
    } else if (a.action === 'call') {
      lastBetAmounts[idx] = a.amount;
    } else {
      // fold / check — retain 0
      lastBetAmounts[idx] = 0;
    }
  }
  return { lastActions, lastBetAmounts };
}

export function mapEngineSnapshot(
  raw: EngineSnapshot,
  heroUserId: string,
  maxSeats: number
): MappedTableStatePatch {
  const s = raw as unknown as EnginePublishedState;

  /* ═══ NEVER DROP A SEAT THE ENGINE SAYS EXISTS (Dan 2026-08-30) ═══════════
     `maxSeats` is caller state (`tableState.maxPlayers`), which BOOTS AT 6 and
     is only corrected when the table row load lands — and a TablePage mounted
     without navigation state (multi-table screens, deep links, tournament
     auto-seat) starts from that default. The loop below used to
     `continue` on any seat above it, so a hero seated in seat 7, 8 or 9 of a
     larger table was silently ERASED from every snapshot: no hole cards, no
     action bar, the footer stuck on "Seat Reserved, You'll Be Dealt In Next
     Hand" while the engine dealt them in, timed out their turns, force-sat
     them out after three strikes, and evicted them at the five-minute mark.
     That is the 2026-08-30 report, verbatim (table 08746c1a, seat 7: the
     engine released the wait-for-BB hold correctly, posted the player's big
     blind, even paid them a pot — and their own client never showed one frame
     of it). The engine's snapshot is authoritative about which seats exist,
     so the arrays size themselves to it and can never disagree with it.
     Pinned by tests/unit/snapshotNeverDropsASeat.law.test.ts.

     ── PHASE 1, 2026-08-31: STOP INFERRING, START READING ──────────────────
     `max_seats` is now published by the engine, which is the only party that
     actually knows (ServerTableEngine, both the live and the idle payload).
     When it is present it WINS outright — including over the caller's
     `maxSeats`, because the caller is guessing and the engine is not, and
     because the inference below has a blind spot the engine does not: it can
     only see OCCUPIED seats, so a 9-max table with nobody past seat 4 still
     drew as a 6-max one and the empty high seats were unclickable.

     The occupied-seat floor survives as the fallback for a snapshot from an
     engine that predates the field — never worse than today, and still
     incapable of dropping a seated player. */
  const highestSeat = (s.players ?? []).reduce((m, p) => Math.max(m, p.seat ?? 0), 0);
  const publishedMaxSeats = Number((s as unknown as { max_seats?: number }).max_seats ?? 0);
  const effectiveMaxSeats =
    Number.isFinite(publishedMaxSeats) && publishedMaxSeats > 0
      ? /* Even the engine's own number may not drop a player it is dealing: if
           the roster somehow exceeds the stated capacity, the seated player
           still wins. A rendered ghost seat is a cosmetic bug; an erased hero
           costs somebody their stack. */
        Math.max(publishedMaxSeats, highestSeat)
      : Math.max(maxSeats, highestSeat);

  // Current player: engine emits a user_id; tableState stores a seat number.
  let currentPlayerSeat = 0;
  if (s.current_player) {
    const cp = s.players.find((p) => p.user_id === s.current_player);
    if (cp) currentPlayerSeat = cp.seat;
  }

  // Per-seat mapping: players array indexed by seat-1.
  const players: MappedTableStatePatch['players'] = Array(effectiveMaxSeats).fill(null);
  const positions: Array<string | null> = Array(effectiveMaxSeats).fill(null);
  for (const p of s.players) {
    const idx = p.seat - 1;
    if (idx < 0 || idx >= effectiveMaxSeats) continue;
    players[idx] = {
      id: p.user_id,
      name: p.username ?? '',
      avatar: p.avatar_url,
      /* Normalised to undefined, never ''. The seat merge in TablePage treats
         a falsy cosmetic as "none equipped" and an empty string would round-trip
         through the realtime merge as a value worth preserving. */
      frame: p.equipped_frame || undefined,
      aura: p.equipped_aura || undefined,
      stack: p.stack,
      status: STATUS_FROM_PLAYER(p),
      holeCards: p.cards && p.cards.length > 0 ? p.cards : undefined,
      showCards: !!(p.cards && p.cards.length > 0 && p.user_id !== heroUserId),
      isHero: p.user_id === heroUserId,
      isMucked: p.is_mucked === true,
    };
    positions[idx] = p.position ?? null;
  }

  const { lastActions, lastBetAmounts } = derivePerSeatLastAction(
    s.action_history ?? [],
    effectiveMaxSeats,
    s.stage ?? 'preflop'
  );

  // AUDIT FIX 2026-07-19 (client-1): the authoritative per-seat current-street
  // wager is `players[].bet` on the snapshot — it includes blinds, straddles,
  // and dead blinds, which never appear in `action_history`. Deriving the
  // chips-in-front purely from action_history left blind posters showing $0,
  // made the BB see "Call BB" instead of "Check", and mis-sized call amounts.
  // The engine resets `bet` to 0 on each street, so this is exactly the
  // current-street contribution. Overwrite the action-derived amounts with it
  // (labels in `lastActions` still come from action_history, which is correct
  // — blinds carry no action label, only chips + a position badge).
  for (const p of s.players) {
    const idx = p.seat - 1;
    if (idx < 0 || idx >= effectiveMaxSeats) continue;
    if (p.is_folded) continue; // folded seats show no chips in front
    lastBetAmounts[idx] = p.bet ?? 0;
  }

  // AUDIT FIX 2026-07-19 (client-5): `pots[].eligible` holds USER IDs, not seat
  // numbers. The old code passed them straight through as `eligibleSeats`, so
  // the seat lookup (players[seat-1]) always missed and side-pot eligibility
  // never rendered. Resolve each user_id to its seat number here.
  const seatByUserId = new Map<string, number>();
  for (const p of s.players) seatByUserId.set(p.user_id, p.seat);
  // LIVE E2E FIX 2026-08-15: `pots[]` on the snapshot is the engine's FULL
  // settlement partition — pots[0] IS the main pot; only pots[1..] are true
  // side pots. Mapping every entry into `sidePots` double-rendered the main
  // pot whenever the partition existed: a single-pot hand displayed
  // "POT 2,745 / SIDE POT 1: 2,745 / TOTAL 5,490", and the artifact carried
  // into the next hand's first snapshots as a phantom side pot. Render only
  // pots[1..] as side pots, and when the partition exists use pots[0] as the
  // displayed main pot (s.pot is the whole-hand total, which already
  // includes every side pot — using it alongside side pots double-counts).
  const rawPots = s.pots ?? [];
  const sidePots = rawPots.slice(1).map((p) => ({
    amount: p.amount,
    eligibleSeats: ((p.eligible ?? []) as unknown[])
      .map((e) => (typeof e === 'string' ? (seatByUserId.get(e) ?? -1) : (e as number)))
      .filter((seat) => seat > 0),
  }));

  // ── Dan 2026-08-18: keep the countdown honest across clock drift ──
  // The engine stamps each broadcast with its own clock. Recording it here -
  // the single place every snapshot passes through - lets the timer measure
  // elapsed time on the ENGINE's clock rather than the device's. See
  // utils/serverClock.ts for why that matters: the ring computed elapsed as
  // `Date.now() - turn_start_time_ms`, mixing the two clocks, so a device clock
  // running fast made a 15-second turn visibly run short.
  recordServerTime(s.server_time_ms);

  // CHIP CONTINUITY: lift the hero's stay clock out of the seat payload.
  const heroRaw = s.players.find((p) => p.user_id === heroUserId);
  const heroLeave: MappedTableStatePatch['heroLeave'] =
    heroRaw && typeof heroRaw.stay_remaining_ms === 'number'
      ? {
          locked: heroRaw.leave_locked === true,
          remainingMs: Math.max(0, heroRaw.stay_remaining_ms),
          running: heroRaw.stay_running === true,
          at:
            typeof s.server_time_ms === 'number' && s.server_time_ms > 0
              ? s.server_time_ms
              : Date.now(),
        }
      : null;

  // Action timer deadline.
  // Phase 1.2 PR-F: prefer the authoritative turn_deadline_ms from the
  // engine. Fall back to start+duration for backward compat with older
  // server builds (will be removed in PR-G once the engine is fully
  // upgraded and Phase 1.1 soak completes).
  let actionTimerDeadline: number | undefined;
  if (s.turn_deadline_ms && s.turn_deadline_ms > 0) {
    actionTimerDeadline = s.turn_deadline_ms;
  } else if (s.turn_start_time_ms && s.turn_duration_ms) {
    actionTimerDeadline = s.turn_start_time_ms + s.turn_duration_ms;
  }

  /* THE DISCARD CLOCK IS THE SERVER'S, NOT A GUESS (2026-08-31).
     The client used to start a 15-second countdown from the moment it first
     SAW the stage, using its own copy of action_time_seconds. A reconnect
     mid-round restarted it from full while the server clock was half spent; a
     table configured with a different action time showed a number that was
     simply wrong. This is the deadline that actually folds you.

     Hero's own entry wins over the round default, because a time bank extends
     one seat without touching the rest. */
  let discardDeadline: number | null = null;
  const ownDiscard = s.discard_deadlines?.[heroUserId];
  if (typeof ownDiscard === 'number' && ownDiscard > 0) {
    discardDeadline = ownDiscard;
  } else if (typeof s.discard_deadline_ms === 'number' && s.discard_deadline_ms > 0) {
    discardDeadline = s.discard_deadline_ms;
  }

  return {
    // See LIVE E2E FIX above: with a settlement partition present, the main
    // pot is pots[0]; otherwise the running total s.pot is the main pot.
    pot: rawPots.length > 0 ? rawPots[0].amount : (s.pot ?? 0),
    communityCards: s.community_cards ?? [],
    communityCards2: s.community_cards2 ?? [],
    // TRIPLE-BOARD BOMB POT 2026-08-27: third board (empty unless active).
    communityCards3: s.community_cards3 ?? [],
    bombPotIn: typeof s.bomb_pot_in === 'number' ? s.bomb_pot_in : null,
    // BOMB POT STANDARDIZATION 2026-08-27: timed-mode due timestamp (epoch ms).
    bombPotNextAt: typeof s.bomb_pot_next_at === 'number' ? s.bomb_pot_next_at : null,
    // 2026-08-29: why a promised bomb has not arrived. The felt used to
    // announce BOMB POT NEXT HAND and then deal ordinary hands indefinitely
    // with no explanation available anywhere.
    bombPotWaitingFor: typeof s.bomb_pot_waiting_for === 'number' ? s.bomb_pot_waiting_for : null,
    // VARIANT OVERRIDE 2026-08-28: the hand's own variant (null on old engines).
    handVariant: typeof s.hand_variant === 'string' && s.hand_variant ? s.hand_variant : null,
    boardStage: s.stage ?? 'preflop',
    dealerSeat: s.dealer_seat ?? 0,
    currentPlayerSeat,
    lastActions,
    lastBetAmounts,
    positions,
    players,
    currentBet: s.current_bet ?? 0,
    minRaise: s.min_raise ?? 0,
    // 2026-08-23: pass the engine's betting structure straight through. The
    // action panel used to re-derive it from the variant string, which made
    // everything that was not PLO no-limit — a fixed-limit table would have
    // drawn a no-limit slider and had every drag rejected.
    bettingStructure: s.betting_structure,
    fixedBetSize: s.fixed_bet_size,
    wagersCapped: s.wagers_capped,

    lastRaise: s.last_raise ?? 0,
    actionTimerDeadline,
    discardDeadline,
    discardDurationMs: typeof s.discard_duration_ms === 'number' ? s.discard_duration_ms : 0,
    actionTimerStartTime: s.turn_start_time_ms,
    actionTimerPlayerId: s.current_player ?? undefined,
    isTimeBankActive: s.time_bank_active ?? false,
    handNumber: s.hand_number ?? 0,
    heroLeave,
    sidePots,
    disconnectStates: s.disconnect_states ?? {},
    // Phase 2 T1-01: winners with net amount. Server emits winners[] with
    // total pot received per winner. We look up the player's totalInvested
    // to compute net profit (what the client shows as "+N" / "-N").
    //
    // Dan 2026-08-23: this is SIGNED, and used to be wrapped in Math.max(0,...).
    // Winning a pot is not the same as making money on it. Chop a pot after the
    // rake comes off the top and a "winner" can take back less than they put
    // in - exactly the case Dan named ("+XXX or -XXX if the pot was chopped and
    // rake was removed"). The clamp turned that real loss into a flat 0, and
    // because the float only renders for a POSITIVE amount it then showed
    // nothing at all: the one hand where a player most wants to know what
    // happened to their chips was the one hand that told them nothing.
    winners: (s.winners ?? []).map((w) => {
      // AUDIT FIX 2026-08-25: the engine historically emitted this entry with
      // a camelCase `userId` while this mapper read `user_id` — every winner
      // mapped to userId undefined / seat 0, and the "+N" net float, the muck
      // loser-mask and the stack hold all silently missed. The engine now
      // emits `user_id`; accept BOTH so either side can deploy first.
      const wid = w.user_id ?? (w as unknown as { userId?: string }).userId ?? '';
      const p = s.players.find((pp) => pp.user_id === wid);
      const invested = p?.totalInvested ?? 0;
      return {
        userId: wid,
        seat: p?.seat ?? 0,
        amount: w.amount,
        netAmount: w.amount - invested,
      };
    }),
    // Bible V8 §4.2 — Waiting-for-BB user IDs (Walkthrough Step 4 fix 2026-04-29)
    waitingForBBUserIds:
      (s as unknown as { waiting_for_bb_user_ids?: string[] }).waiting_for_bb_user_ids ?? [],
    // Dan 2026-08-29 — see the field docs. Absent on an engine older than the
    // fix, which maps to "nobody has a standing agreement" and leaves the
    // pre-fix behaviour exactly as it was rather than hiding a live prompt.
    postBBDeferredUserIds:
      (s as unknown as { post_bb_deferred_user_ids?: string[] }).post_bb_deferred_user_ids ?? [],
    // Phase 1 (2026-08-31): the resolved seat count, identical to the length
    // of every per-seat array in this patch. See the field docs above.
    maxSeats: effectiveMaxSeats,
  };
}
