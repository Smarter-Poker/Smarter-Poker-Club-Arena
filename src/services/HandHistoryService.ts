/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Hand History Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages hand history data for replay and sharing
 * Real Supabase integration — no demo data
 */

import { supabase } from '../lib/supabase';
import type { Card } from '../types/database.types';
import { derivePositions } from '../utils/pokerPositions';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { buildReplay } from '../utils/handReplay';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
//
// Round 38 RE-RUN cleanup: removed HandPlayerDB / HandActionDB / TableDB / HandDB
// and the methods that consumed them (getTableHands, getRecentWinningHands,
// searchHands, mapHandRecord). Those types described the legacy `hands` /
// `hand_players` / `hand_actions` tables, which are EMPTY in production
// (0 rows each) — see BUG 021 FIX comment on getPlayerHands. The canonical
// store is `hand_history` (5.15M rows) and its mapper is mapHandHistoryRow.
// Dead-code removal aligns with the "no stubs / no broken paths" rule.

export interface HandPlayer {
  seat: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  /**
   * Empty when the button is not among the occupied seats — a dead button, or
   * a row written before `button_seat` existed. A missing badge is honest; a
   * wrong one is not, and a wrong one is what this field held until
   * 2026-08-27. See the note on `buttonSeat` in mapHandHistoryRow.
   */
  position: 'UTG' | 'UTG+1' | 'UTG+2' | 'MP' | 'MP+1' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB' | '';
  hole_cards: Card[];
  final_hand?: string;
  result: number;
  is_winner: boolean;
  /**
   * SHOWDOWN POLISH 2026-08-25: the persisted reveal record (hand_history.
   * showdown, migration 20260825) — what the table actually SAW. mucked
   * entries carry no hand identity by design. Absent on hands that predate
   * the column or never reached showdown.
   */
  showdown_reveal?: {
    reveal_order: number;
    mucked: boolean;
    hand_name?: string;
    hand_description?: string;
  };
}

export interface HandAction {
  player_id: string;
  /* These are the values the ENGINE STORES, verified in production over 11.8M
     action rows on 2026-08-23. This union previously read `'all-in'` while
     every row says `all_in`, and the mapper below cast straight through it, so
     the type was a lie the compiler happily enforced against nobody: anyone
     writing `a.action === 'all-in'` got silence and a branch that never ran.
     `discard` (74,631 rows, draw and pineapple games) was missing outright. */
  /* FORCED MONEY + RETURNS 2026-08-27: the engine now also records what it
     used to move silently — `sb`, `bb`, `ante`, `straddle`, `post` (a dead
     blind or a "post BB to enter") and `return` (an uncalled bet coming back).
     Adding them to the union is not cosmetic: this type is the contract every
     consumer narrows against, and the last time it disagreed with the database
     the mismatch was invisible for months. `return` carries a POSITIVE amount;
     the verb is what makes it money leaving the pot. */
  action:
    | 'fold'
    | 'check'
    | 'call'
    | 'bet'
    | 'raise'
    | 'all_in'
    | 'discard'
    | 'sb'
    | 'bb'
    | 'ante'
    | 'straddle'
    | 'post'
    | 'return';
  amount?: number;
  /** Stored as `stage`. `pineapple_discard` is a real street here. */
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'pineapple_discard';
  timestamp: number;
  /**
   * PHASE 4 COMPLETION 2026-09-01 — the card thrown on a `discard` action,
   * and ONLY ever the viewer's own.
   *
   * Phase 4 taught the standalone replay which card you threw and stopped
   * there, so the hand-history panel that slides out AT THE TABLE - the
   * surface a player actually reviews the last hand on, mid-session - still
   * printed the word "discard" and nothing else. Same fetch, same RLS, same
   * map; it simply never reached this list.
   *
   * It carries no privacy decision of its own: `fetchOwnDiscards` reads
   * `hand_discards` through `hand_discards_read_own`, so the map it fills can
   * only ever hold the caller's rows. Absent on every other player's discard
   * and on every non-discard action.
   */
  discarded_card?: { rank: string; suit: string };
}

/** One winner of one pot, as stored. */
export interface HandWinner {
  user_id: string;
  /** Chips taken from the pot. NOT the player's net result. */
  amount: number;
  /** Potindex 0 is the main pot; higher indices are side pots. */
  pot_index: number;
  hand_name?: string;
}

export interface HandRecord {
  id: string;
  serial_number: string;
  table_id: string;
  table_name: string;
  played_at: string;
  hand_number: number;
  total_hands: number;
  main_pot: number;
  side_pots: number[];
  community_cards: Card[];
  /** Round 2 (double board): board 2, empty on single-board hands. */
  community_cards2?: Card[];
  /** TRIPLE-BOARD BOMB POT 2026-08-27: board 3, empty below three boards. */
  community_cards3?: Card[];
  /**
   * BOMB POT FACTS (spec §20, 2026-08-28): the frozen trigger record —
   * why the hand was a bomb, the ante, boards dealt, and (when overridden)
   * the variant it was played as. Null on normal hands and rows that
   * predate the column.
   */
  bomb_pot?: {
    trigger_reason?: string;
    ante_amount?: number;
    board_count?: number;
    variant?: string;
  } | null;
  /**
   * COMPLETENESS PASS 2026-08-26: Run It Twice boards 2..N in run order
   * (board 1 is community_cards). Read from the first-class
   * hand_history.rit_boards column, with a fallback parse of the
   * `rit_board_N:` pseudo-actions for the rows that predate it. Empty on
   * single-run hands.
   */
  rit_boards?: Card[][];
  players: HandPlayer[];
  actions: HandAction[];
  /* Real per-winner amounts. Consumers used to reconstruct these by dividing
     main_pot by the number of winners, which is wrong on every split pot and
     on every hand with a side pot — and it was presented to the recipient of a
     shared hand as fact. The row has always carried the true figure. */
  winners: HandWinner[];
  /**
   * WHO WON EACH RUN (2026-09-04, column hand_history.winners_by_board). One
   * entry per (board, winner): the board index (1-based), the pre-rake share
   * and the hand name ON THAT BOARD. Empty on single-board hands and on rows
   * that predate the column, in which case the surfaces fall back to the
   * aggregate `winners` and say so.
   */
  winners_by_board: { board: number; user_id: string; amount: number; hand_name?: string }[];
  /** Rake taken from the pot, and the jackpot drop. Shown, not hidden. */
  rake: number;
  bbj_fee: number;
  game_type: string;
  stakes: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class HandHistoryServiceClass {
  /**
   * Get a single hand by ID.
   *
   * Round 38 RE-RUN fix: previously queried `hands` (0 rows in prod) with a
   * nested join to `hand_players` and `hand_actions` (also 0 rows each). Result:
   * every call returned null, so the entire hand-replay feature (HandReplay
   * component + HandReplayerPage) was dead in production. Same root cause as
   * BUG 021 FIX in getPlayerHands.
   *
   * Fix: query `hand_history` (5.15M rows, the canonical store), use the
   * existing mapHandHistoryRow mapper, and resolve profile names from the
   * JSONB `players` array.
   */
  async getHand(handId: string): Promise<HandRecord | null> {
    const { data, error } = await supabase
      .from('hand_history')
      .select(
        'id, created_at, started_at, table_id, hand_number, pot_size, community_cards, community_cards2, community_cards3, rit_boards, players, actions, winners, game_variant, small_blind, big_blind, rake_amount, bbj_amount, button_seat, hole_cards, showdown, pots, bomb_pot'
      )
      .eq('id', handId)
      .maybeSingle();

    if (error || !data) {
      if (error) reportError(error, 'HandHistoryService.getHand_query');
      return null;
    }

    const userIds: string[] = [];
    for (const p of (data as any).players || []) if (p?.userId) userIds.push(p.userId);
    for (const w of (data as any).winners || []) if (w?.userId) userIds.push(w.userId);
    const profileMap = await this.fetchProfileMap(userIds);

    return this.mapHandHistoryRow(data, profileMap, await this.fetchOwnDiscards([data]));
  }

  /**
   * Get hands for a player.
   *
   * BUG 021 FIX (2026-04-15): previously queried `hand_players` table (EMPTY — 0 rows) with a
   * nested join to `hands` (also empty). The canonical hand history store is `hand_history`
   * (5.1M rows in prod) with JSONB columns `players`, `actions`, `winners`. Rewrote to filter
   * by players JSONB containing the requested userId, then map JSONB → HandRecord inline.
   */
  async getPlayerHands(
    userId: string,
    limit = 50,
    opts: {
      /**
       * THE TABLE YOU ARE SITTING AT (Dan 2026-09-04: "doesn't display the
       * correct hands"). Without this, the live table's Previous Hand and
       * Hand History showed the player's last 50 hands ANYWHERE - other
       * stakes, other clubs, tournaments - interleaved by insert time. The
       * standalone Hand History page is the cross-table view and passes
       * nothing; a live table always passes its own id.
       */
      tableId?: string | null;
    } = {}
  ): Promise<HandRecord[]> {
    // BUG 021 Layer D (2026-04-16): Supabase JS `.contains('column', [{key: val}])` serializes
    // the object literal with unquoted keys, producing invalid JSON in PostgREST. Symptom:
    //   {"code":"22P02","details":"Expected string or '}', but found '['","message":"invalid input syntax for type json"}
    // Fix: pass a pre-stringified JSON string, which Supabase JS URL-encodes verbatim.
    const containmentJson = JSON.stringify([{ userId }]);
    let query = supabase
      .from('hand_history')
      .select(
        'id, created_at, started_at, table_id, hand_number, pot_size, community_cards, community_cards2, community_cards3, rit_boards, players, actions, winners, winners_by_board, game_variant, small_blind, big_blind, rake_amount, bbj_amount, button_seat, hole_cards, showdown, pots'
      )
      .contains('players', containmentJson);
    if (opts.tableId) query = query.eq('table_id', opts.tableId);
    const { data, error } = await query
      /* PLAY ORDER, NOT INSERT ORDER (Dan 2026-09-04: "un organized"). This
         sorted by created_at, which is when the ROW landed: the writer's retry
         queue drains failed inserts minutes later, so during any database
         blip hands landed out of order and stayed that way. hand_number is
         globally monotonic (GLOBAL_HAND_NUMBER_FLOOR) and is the play order. */
      .order('hand_number', { ascending: false })
      .limit(limit);

    if (error || !data) {
      if (error) reportError(error, 'HandHistoryService.getPlayerHands_hand_history_query');
      return [];
    }

    // Collect all user ids across all hands, including winners — needed to resolve display names
    const allUserIds: string[] = [];
    for (const row of data as any[]) {
      for (const p of row.players || []) if (p?.userId) allUserIds.push(p.userId);
      for (const w of row.winners || []) if (w?.userId) allUserIds.push(w.userId);
    }
    const profileMap = await this.fetchProfileMap(allUserIds);
    /* One query for the whole page of hands. RLS narrows it to this viewer's
       own rows, so the size of the result is bounded by how many of THEIR
       hands are on screen, not by how many players were in them. */
    const discardsByHand = await this.fetchOwnDiscards(data as any[]);

    return data
      .map((d: any) => this.mapHandHistoryRow(d, profileMap, discardsByHand))
      .filter((h: HandRecord | null): h is HandRecord => h !== null);
  }

  // Round 38 RE-RUN cleanup: deleted 3 dead methods that queried the empty
  // `hands` / `hand_players` tables and had ZERO callers in the codebase:
  //   - getTableHands(tableId)
  //   - getRecentWinningHands(userId)
  //   - searchHands(filters)
  // If any of these features is wanted later, re-add via hand_history +
  // mapHandHistoryRow (the canonical pattern used by getPlayerHands and getHand).

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * BUG 021 FIX — map a row from `hand_history` (the canonical prod source) to a HandRecord.
   * hand_history stores players + actions + winners as JSONB with camelCase keys
   * (userId, not user_id). We compute result per hand by looking up the player in winners[]
   * and subtracting their total invested from actions[].
   */
  /* No `requestingUserId` parameter any more, on purpose. It existed only to
     feed an `isMe || isWinner` hole-card gate that hid holdings the table had
     already been shown (see the hole_cards comment below). Reintroducing a
     per-viewer argument here is how that bug comes back: the row already
     encodes what is public, so the mapper must not second-guess it. */
  /**
   * PHASE 4 2026-09-01 - the viewer's own discarded cards, for the hands about
   * to be rendered.
   *
   * THERE IS NO USER ID IN THIS QUERY, and that is the design rather than an
   * omission. `hand_discards` is read through `hand_discards_read_own`
   * (auth.uid() = user_id), so asking for "every discard in these hands"
   * returns exactly the caller's own and nothing else. The privacy of the
   * variant's one private card is enforced by Postgres, not by this method
   * remembering to filter - which is the difference between a rule and a
   * habit. A bug here cannot widen it.
   *
   * Keyed `<table_id>:<hand_number>` because that is the pair the replay has
   * in hand; `id` is a hand_history primary key and means nothing to this
   * table.
   */
  private async fetchOwnDiscards(
    rows: Array<{ table_id?: string | null; hand_number?: number | null }>
  ): Promise<Map<string, { seat: number; card: { rank: string; suit: string } }>> {
    const out = new Map<string, { seat: number; card: { rank: string; suit: string } }>();
    const tableIds = [...new Set(rows.map((r) => r?.table_id).filter(Boolean))] as string[];
    const handNumbers = [
      ...new Set(rows.map((r) => Number(r?.hand_number)).filter((n) => Number.isFinite(n))),
    ];
    if (tableIds.length === 0 || handNumbers.length === 0) return out;
    try {
      const { data, error } = await supabase
        .from('hand_discards')
        .select('table_id, hand_number, seat_number, discarded_card')
        .in('table_id', tableIds)
        .in('hand_number', handNumbers);
      if (error) {
        // A replay without the discard is the pre-2026-09-01 replay, which is
        // a complete and correct hand. Never fail the history for it.
        reportError(error, 'HandHistoryService.fetchOwnDiscards');
        return out;
      }
      for (const d of data || []) {
        const row = d as any;
        const card = row?.discarded_card;
        if (!card?.rank || !card?.suit) continue;
        out.set(`${row.table_id}:${row.hand_number}`, {
          seat: Number(row.seat_number) || 0,
          card,
        });
      }
    } catch (e) {
      reportError(e, 'HandHistoryService.fetchOwnDiscards_threw');
    }
    return out;
  }

  private mapHandHistoryRow(
    row: any,
    profileMap: Map<string, { username: string; avatar_url: string | null }>,
    discardsByHand?: Map<string, { seat: number; card: { rank: string; suit: string } }>
  ): HandRecord | null {
    if (!row?.id) return null;
    const jsonbPlayers: any[] = Array.isArray(row.players) ? row.players : [];
    const jsonbActions: any[] = Array.isArray(row.actions) ? row.actions : [];
    const jsonbWinners: any[] = Array.isArray(row.winners) ? row.winners : [];

    /**
     * THE BUTTON. `row.button_seat` is written by the engine on every hand and
     * was never selected here; this read it from `players[].isButton`, a field
     * NOTHING in the codebase has ever written, so it fell back to seat 1 on
     * every hand and every position badge the table drew was wrong.
     *
     * `isButton` is kept only as a floor for a hypothetical row shape; it has
     * never resolved in production.
     */
    const buttonSeat: number | null = Number.isFinite(Number(row?.button_seat))
      ? Number(row.button_seat)
      : ((jsonbPlayers.find((p) => p?.isButton)?.seat as number | undefined) ?? null);

    /**
     * Positions come from `derivePositions`, which is the one correct
     * derivation in this codebase. The local `getPositionName` it replaced did
     * `(seat - buttonSeat + playerCount) % playerCount` — modular arithmetic on
     * RAW seat numbers, which is wrong the moment seating is sparse, and a
     * six-handed hand on seats 1, 2, 3, 5, 8, 9 is the normal case here.
     * `pokerPositions.ts` was written for exactly this and says so in its own
     * header; this file simply never used it.
     */
    const positionBySeat = derivePositions(
      jsonbPlayers.map((p) => Number(p?.seat)).filter((s) => Number.isFinite(s)),
      buttonSeat
    );

    /**
     * PER-PLAYER NET, rebuilt properly.
     *
     * This used to sum `actions[].amount` for what a player invested. The
     * engine writes that field as the raise-TO level for bet/raise/all_in and
     * as the chips added for call (HandController.ts:600-724), so the sum
     * double-counts every re-raise: on production hand 3048511 it makes
     * HighRoller's investment 174.10 against a true 161.10, and his net is
     * shown 13 chips worse than it was.
     *
     * `buildReplay` differences each to-level against what that seat already
     * had in on the street, and adds the blinds the action log never records.
     * Measured across the 4,000 most recent live hands it lands on the stored
     * `pot_size` on 99.18%; the naive sum lands on it only when nobody raised.
     *
     * Where a hand carries an ante or a straddle — recorded in no column and no
     * action — neither method is exact, but this one is short by the forced
     * money rather than long by every raise.
     */
    /* The viewer's own discard for THIS hand, if there is one.
    
       Resolved through the SEAT the row carries rather than through a viewer
       id passed down from the caller. That is deliberate: this mapper used to
       take a `requestingUserId` and the comment above records what it cost -
       a per-viewer argument here is how a card-visibility gate gets rebuilt in
       the mapper, wrongly. It needs no such argument. The map holds only the
       viewer's rows because Postgres allows nothing else, and the seat says
       which player in this hand they were. */
    const ownDiscard = discardsByHand?.get(`${row.table_id}:${row.hand_number}`);
    const discardedCards: Record<string, { rank: string; suit: string }> = {};
    if (ownDiscard) {
      const seated = jsonbPlayers.find((p) => Number(p?.seat) === ownDiscard.seat);
      if (seated?.userId) discardedCards[String(seated.userId)] = ownDiscard.card;
    }

    const replay = buildReplay({
      discardedCards,
      handNumber: row.hand_number ?? null,
      playedAt: row.started_at ?? row.created_at ?? null,
      gameVariant: row.game_variant ?? null,
      smallBlind: Number(row.small_blind) || 0,
      bigBlind: Number(row.big_blind) || 0,
      potSize: Number(row.pot_size) || 0,
      rakeAmount: Number(row.rake_amount) || 0,
      buttonSeat,
      board: row.community_cards ?? [],
      players: jsonbPlayers.map((p) => ({
        userId: String(p?.userId ?? ''),
        username: String(p?.username ?? ''),
        seat: Number(p?.seat) || 0,
        stack: p?.stack === undefined || p?.stack === null ? null : Number(p.stack),
      })),
      actions: jsonbActions.map((a) => ({
        seat: Number(a?.seat) || 0,
        userId: String(a?.userId ?? ''),
        action: String(a?.action ?? ''),
        amount: Number(a?.amount) || 0,
        stage: a?.stage ?? null,
      })),
      winners: jsonbWinners.map((w) => ({
        userId: String(w?.userId ?? ''),
        amount: Number(w?.amount) || 0,
      })),
      holeCards: (row?.hole_cards as Record<string, never[]>) ?? {},
    });
    const netByUser = new Map(replay.players.map((p) => [p.userId, p.net]));
    const buildResult = (userId: string): number => netByUser.get(userId) ?? 0;

    const playerCount = jsonbPlayers.length || 1;

    /* The hand's hole cards live in their own JSONB column, keyed by user id:
       { "<uuid>": [{ rank: 'A', suit: 'spades' }, ...] }. See the server's
       handHistory.ts `hole_cards: holeCardsPayload`. */
    const holeCardsByUser: Record<string, unknown[]> =
      row && typeof (row as any).hole_cards === 'object' && (row as any).hole_cards
        ? ((row as any).hole_cards as Record<string, unknown[]>)
        : {};

    /* SHOWDOWN POLISH 2026-08-25: the reveal record, keyed by user id. */
    const showdownByUser = new Map<string, any>();
    if (Array.isArray((row as any).showdown)) {
      for (const e of (row as any).showdown as any[]) {
        if (e && typeof e.user_id === 'string') showdownByUser.set(e.user_id, e);
      }
    }

    const players: HandPlayer[] = jsonbPlayers.map((p: any): HandPlayer => {
      const uid: string = p?.userId || '';
      const profile = profileMap.get(uid);
      const isWinner = jsonbWinners.some((w) => w?.userId === uid);
      /* PRESENCE IS THE REVEAL FLAG. The server writes `hole_cards` ONLY for
         showdown-revealed holdings — see server/src/services/supabase/
         handHistory.ts, which builds holeCardsByUser from `showdownResults`
         alone and deliberately never persists a mucked hand. So a user id
         appearing as a key in that object is itself proof the table saw the
         cards face up, and no further gate is needed or correct.
         `players[].cards` is the legacy fallback; it is `[]` on every
         production row, so it can only ever contribute nothing. */
      const revealed: unknown[] =
        Array.isArray(holeCardsByUser[uid]) && holeCardsByUser[uid].length
          ? holeCardsByUser[uid]
          : Array.isArray(p?.cards)
            ? p.cards
            : [];
      return {
        seat: Number(p?.seat) || 0,
        user_id: uid,
        username: profile?.username || p?.username || (uid ? uid.slice(0, 8) : 'Unknown'),
        avatar_url: profile?.avatar_url || null,
        position: (positionBySeat[Number(p?.seat) || 0] ?? '') as HandPlayer['position'],
        /* 2026-08-23 (Dan, with a screenshot): the Showdown block drew two grey
           card backs for every villain who reached showdown and LOST. This line
           gated the stored holdings behind `isMe || isWinner`, so a losing
           showdown hand — cards the whole table had just watched turn over —
           was mapped to `[]` and rendered as face-down placeholders. Measured
           on production over six hours: 9,407 of 17,025 stored holdings (55%)
           belonged to a non-winner and were discarded between the row and the
           screen. The gate is now gone: see `revealed` above for why presence
           in the column is the only reveal check that is actually true. */
        hole_cards: revealed as Card[],
        final_hand: jsonbWinners.find((w) => w?.userId === uid)?.hand?.name || undefined,
        result: buildResult(uid),
        is_winner: isWinner,
        showdown_reveal: showdownByUser.has(uid)
          ? {
              reveal_order: Number(showdownByUser.get(uid)?.reveal_order) || 0,
              mucked: showdownByUser.get(uid)?.mucked === true,
              hand_name: showdownByUser.get(uid)?.hand_name || undefined,
              hand_description: showdownByUser.get(uid)?.hand_description || undefined,
            }
          : undefined,
      };
    });

    /* COMPLETENESS PASS 2026-08-26: Run It Twice boards 2..N. The first-class
       column (migration 20260826_hand_history_rit_boards) is authoritative;
       rows that predate it carry the boards as `rit_board_N:<cards>`
       pseudo-actions inside `actions`, which this parses back out. Either
       way the pseudo-entries are FILTERED from the action list below — they
       used to leak into every replay's action feed as a bogus system entry. */
    const ritPseudo = /^rit_board_(\d+):/;
    let rit_boards: Card[][] = [];
    if (Array.isArray((row as any).rit_boards) && (row as any).rit_boards.length > 0) {
      rit_boards = ((row as any).rit_boards as unknown[][]).map(
        (b) => (Array.isArray(b) ? b : []) as Card[]
      );
    } else {
      rit_boards = jsonbActions
        .map((a: any) => {
          const m = typeof a?.action === 'string' ? ritPseudo.exec(a.action) : null;
          if (!m) return null;
          return {
            run: Number(m[1]),
            cards: String(a.action)
              .slice(m[0].length)
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean) as unknown as Card[],
          };
        })
        .filter((b): b is { run: number; cards: Card[] } => b !== null && b.cards.length > 0)
        .sort((x, y) => x.run - y.run)
        .map((b) => b.cards);
    }

    const actions: HandAction[] = jsonbActions
      .filter((a: any) => !(typeof a?.action === 'string' && ritPseudo.test(a.action)))
      .map(
        (a: any): HandAction => ({
          player_id: a?.userId || '',
          action: (a?.action as HandAction['action']) || 'fold',
          amount: typeof a?.amount === 'number' ? a.amount : undefined,
          street: (a?.stage as HandAction['street']) || 'preflop',
          /* The thrown card, on the viewer's own discard row. `discardedCards`
             is keyed by user id and holds nothing but this viewer's rows (see
             fetchOwnDiscards), so the lookup is the whole gate. */
          discarded_card:
            a?.action === 'discard' ? discardedCards[String(a?.userId || '')] : undefined,
          timestamp:
            typeof a?.timestamp === 'number' ? a.timestamp : new Date(row.created_at).getTime(),
        })
      );

    const winners: HandWinner[] = jsonbWinners.map((w: any) => ({
      user_id: w?.userId || '',
      amount: typeof w?.amount === 'number' ? w.amount : Number(w?.amount) || 0,
      pot_index: typeof w?.potIndex === 'number' ? w.potIndex : 0,
      hand_name: typeof w?.hand?.name === 'string' ? w.hand.name : undefined,
    }));

    const sb = Number(row.small_blind) || 0;
    const bb = Number(row.big_blind) || 0;
    const stakes = sb > 0 && bb > 0 ? `${sb}/${bb}` : '1/2';

    return {
      id: row.id,
      serial_number: row.id,
      table_id: row.table_id,
      table_name: 'Table',
      // Play time, not insert time: a retry-queued row lands minutes later.
      played_at: (row as any).started_at || row.created_at,
      hand_number: Number(row.hand_number) || 1,
      total_hands: 1,
      main_pot: Number(row.pot_size) || 0,
      side_pots: [],
      community_cards: Array.isArray(row.community_cards) ? row.community_cards : [],
      community_cards2: Array.isArray((row as any).community_cards2)
        ? (row as any).community_cards2
        : [],
      community_cards3: Array.isArray((row as any).community_cards3)
        ? (row as any).community_cards3
        : [],
      bomb_pot:
        (row as any).bomb_pot && typeof (row as any).bomb_pot === 'object'
          ? (row as any).bomb_pot
          : null,
      rit_boards,
      players,
      actions,
      winners,
      winners_by_board: Array.isArray((row as any).winners_by_board)
        ? ((row as any).winners_by_board as any[])
            .filter((w) => w && typeof w === 'object' && w.userId)
            .map((w) => ({
              board: Number(w.board) || 1,
              user_id: String(w.userId),
              amount: Number(w.amount) || 0,
              hand_name: typeof w.handName === 'string' ? w.handName : undefined,
            }))
        : [],
      rake: Number(row.rake_amount) || 0,
      bbj_fee: Number((row as any).bbj_amount) || 0,
      game_type: (row.game_variant || 'nlh').toUpperCase(),
      stakes,
    };
  }

  // Round 38 RE-RUN cleanup: deleted private mapHandRecord(HandDB) — only
  // consumer was the now-deleted dead methods (getTableHands /
  // getRecentWinningHands / searchHands). The active mapper is
  // mapHandHistoryRow above.

  /**
   * Batch-fetch profiles for a list of user_ids
   */
  private async fetchProfileMap(
    userIds: string[]
  ): Promise<Map<string, { username: string; avatar_url: string | null }>> {
    const map = new Map<string, { username: string; avatar_url: string | null }>();
    if (userIds.length === 0) return map;

    try {
      const unique = [...new Set(userIds)];
      const { data } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
        .in('id', unique);

      for (const p of data || []) {
        map.set(p.id, { username: playerDisplayName(p), avatar_url: p.avatar_url });
      }
    } catch (err: unknown) {
      reportError(err, 'HandHistoryService.fetchProfileMap');
      // Non-critical — names will fall back to truncated user_id
    }

    return map;
  }

  /**
   * Save a completed hand to Supabase for cross-device persistence and admin review.
   * Fire-and-forget — localStorage is the primary real-time store.
   */
  async saveHandToSupabase(
    tableId: string,
    handData: {
      handNumber: number;
      pot: number;
      communityCards: Array<{ rank: string; suit: string }>;
      players: Array<{
        id: string;
        name: string;
        seat: number;
        stack: number;
        holeCards?: Array<{ rank: string; suit: string }>;
        isWinner?: boolean;
        result?: number;
      }>;
      actions: Array<{
        seat: number;
        action: string;
        amount?: number;
        street: string;
      }>;
      winners: Array<{
        playerId: string;
        amount: number;
        hand?: string;
      }>;
    }
  ): Promise<void> {
    try {
      // 1. Insert the hand record
      const { data: handRecord, error: handErr } = await supabase
        .from('hands')
        .insert({
          table_id: tableId,
          hand_number: handData.handNumber,
          // `hands` names it `pot`. `hand_history` is the table with `pot_size`,
          // and the two were crossed, so every save here was rejected.
          pot: handData.pot,
          community_cards: handData.communityCards,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .maybeSingle();

      if (handErr || !handRecord) {
        console.debug('[HandHistory] Failed to save hand:', handErr?.message);
        return;
      }

      const handId = handRecord.id;

      // 2. Insert hand_players
      const playerRows = handData.players.map((p) => ({
        hand_id: handId,
        user_id: p.id,
        seat: p.seat,
        hole_cards: p.holeCards || [],
        result: p.result || 0,
        is_winner: handData.winners.some((w) => w.playerId === p.id),
        final_hand: handData.winners.find((w) => w.playerId === p.id)?.hand || null,
      }));

      if (playerRows.length > 0) {
        await supabase.from('hand_players').insert(playerRows);
      }

      // 3. Insert hand_actions
      const actionRows = handData.actions.map((a, idx) => {
        const player = handData.players.find((p) => p.seat === a.seat);
        return {
          hand_id: handId,
          player_id: player?.id || '',
          action: a.action,
          amount: a.amount || 0,
          street: a.street,
          created_at: new Date(Date.now() + idx).toISOString(), // Preserve ordering
        };
      });

      if (actionRows.length > 0) {
        await supabase.from('hand_actions').insert(actionRows);
      }

      console.debug(`[HandHistory] Saved hand #${handData.handNumber} to Supabase (id: ${handId})`);
    } catch (err: unknown) {
      // Non-critical — localStorage is the primary store
      reportError(err, 'HandHistoryService.saveHandToSupabase');
    }
  }
}

export const handHistoryService = new HandHistoryServiceClass();
export const HandHistoryService = handHistoryService;
export default handHistoryService;
