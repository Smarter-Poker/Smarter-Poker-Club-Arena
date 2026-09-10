/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY ADAPTER — service row shape -> panel view model
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Moved out of TablePage.tsx on 2026-08-19 (see tableSeatGeometry for why that
 * file is being emptied). This one is worth pinning: it is the only thing
 * standing between the stored hand and what a player is shown about a hand they
 * already played — the pot, who won, how much, and their own result. A quiet
 * change here misreports money after the fact, and there is nothing on screen
 * to suggest the number came out wrong.
 */
import type { HandRecord as ServiceHandRecord } from '../services/HandHistoryService';
import type { HandRecord as PanelHandRecord } from '../components/table/HandHistoryPanel';
import type { ShareableHand } from '../components/table/ShareHand';
import { toCardCodes, toCardCode } from '../utils/cardCode';
import { buildReplay, type ReplayModel } from '../utils/handReplay';
import { shareableFromModel, toShareVariant } from './shareHandModel';

/* Re-exported because this module was the only home `toShareVariant` ever had
   and its callers (and its tests) name it here. The mapping itself lives with
   the share model now, beside the producer that uses it. */
export { toShareVariant };

/**
 * Dan 2026-08-15 — HandRecord adapter (build fix).
 *
 * There are two unrelated `HandRecord` types: the snake_case row shape
 * returned by HandHistoryService (the Supabase `hand_history` projection) and
 * the camelCase view-model HandHistoryPanel renders. Commit ee1a310f5 wired
 * the panel to the service and passed one straight into the other, which does
 * not typecheck — main was red. This maps between them explicitly.
 *
 * Two fields genuinely have no source in the row and are marked rather than
 * faked: per-street pot totals (only the final pot is stored) and per-player
 * stack at time of hand. Everything the panel actually displays — players,
 * positions, hole cards, actions by street, winners, hero result — is real.
 */
/**
 * A model for a service record that arrived WITHOUT one - a fixture, or a
 * record shaped by an older producer. Built by the same `buildReplay` from
 * the record's own fields, so there is still exactly one algorithm; this is
 * only a second way of feeding it. `HandHistoryService` attaches the model
 * built from the raw row, which is richer (stacks, showdown order, pots).
 */
export function replayFromServiceRecord(h: ServiceHandRecord): ReplayModel {
  const [sbRaw, bbRaw] = String(h.stakes || '').split('/');
  const seatOf = new Map((h.players || []).map((p) => [p.user_id, p.seat]));
  const holeCards: Record<string, { rank: string; suit: string }[]> = {};
  const showdown: {
    user_id: string;
    mucked: boolean;
    hand_name?: string;
    reveal_order?: number;
  }[] = [];
  for (const p of h.players || []) {
    if (p.hole_cards && p.hole_cards.length) holeCards[p.user_id] = p.hole_cards as never;
    if (p.showdown_reveal) {
      showdown.push({
        user_id: p.user_id,
        mucked: !!p.showdown_reveal.mucked,
        hand_name: p.showdown_reveal.hand_name,
        reveal_order: p.showdown_reveal.reveal_order,
      });
    }
  }
  const privateHoleCards: Record<string, { rank: string; suit: string }[]> = {};
  for (const p of h.players || []) {
    if (p.private_hole_cards?.length) privateHoleCards[p.user_id] = p.private_hole_cards as never;
  }
  return buildReplay({
    handNumber: h.hand_number ?? null,
    playedAt: h.played_at ?? null,
    gameVariant: h.game_type ?? null,
    smallBlind: Number(sbRaw) || 0,
    bigBlind: Number(bbRaw) || 0,
    potSize:
      (Number(h.main_pot) || 0) + (h.side_pots || []).reduce((a, b) => a + (Number(b) || 0), 0),
    rakeAmount: Number(h.rake) || 0,
    bbjAmount: Number(h.bbj_fee) || 0,
    buttonSeat: (h.players || []).find((p) => p.position === 'BTN')?.seat ?? null,
    board: (h.community_cards || []) as never,
    extraBoards: [
      ...((h.rit_boards || []) as never[]),
      ...(h.community_cards2?.length ? [h.community_cards2 as never] : []),
      ...(h.community_cards3?.length ? [h.community_cards3 as never] : []),
    ],
    players: (h.players || []).map((p) => ({
      userId: p.user_id,
      username: p.username,
      seat: p.seat,
      stack: null,
    })),
    actions: (h.actions || []).map((a) => ({
      seat: seatOf.get(a.player_id) ?? 0,
      userId: a.player_id,
      action: a.action,
      amount: a.amount ?? 0,
      stage: a.street,
    })),
    winners: (h.winners || []).map((w) => ({
      userId: w.user_id,
      amount: w.amount,
      potIndex: w.pot_index,
      hand: w.hand_name ? { name: w.hand_name } : null,
    })),
    winnersByBoard: (h.winners_by_board || []).map((w) => ({
      board: w.board,
      userId: w.user_id,
      amount: w.amount,
      handName: w.hand_name,
      low: w.low === true,
    })),
    holeCards,
    privateHoleCards,
    showdown,
    pots: null,
    discardedCards: Object.fromEntries(
      (h.actions || [])
        .filter((a) => a.discarded_card)
        .map((a) => [a.player_id, a.discarded_card as { rank: string; suit: string }])
    ),
  });
}

export function adaptServiceHandToPanel(h: ServiceHandRecord, heroId: string): PanelHandRecord {
  const replay: ReplayModel = h.replay ?? replayFromServiceRecord(h);
  /* 2026-08-23: this used to be a local
   *   `(c: { rank, suit }) => `${c.rank}${c.suit.charAt(0)}``
   * applied to community_cards, which production stores as STRINGS with the
   * suit spelled out — ["Jdiamonds","6diamonds","4clubs",...]. `c.rank` was
   * undefined on every card of every hand, so the panel printed "UNDEFINE"
   * beside a diamond (the "d" of "undefined"). toCardCode knows every shape
   * the store holds, including the objects the hole_cards column really does
   * use, and refuses the literal "undefined" rather than parsing it as a rank.
   */
  const board = toCardCodes(h.community_cards);
  // Board is dealt 3/1/1; slice it back into the streets that revealed it.
  const streetCards: Record<string, string[] | undefined> = {
    preflop: undefined,
    flop: board.slice(0, 3),
    turn: board.slice(3, 4),
    river: board.slice(4, 5),
  };

  const nameFor = (uid: string) =>
    (h.players || []).find((p) => p.user_id === uid)?.username ||
    replay.players.find((p) => p.userId === uid)?.username ||
    'Player';

  /* `pineapple_discard` was missing from this list, so every discard action
     in a pineapple hand was filtered out and simply never appeared in the
     panel or the exported text. Placement is measured, not assumed: over 31
     consecutive pineapple hands the discard falls after preflop and before
     the flop, 31 of 31. */
  const streets = (['preflop', 'pineapple_discard', 'flop', 'turn', 'river'] as const)
    .map((name) => ({
      name,
      cards: streetCards[name]?.length ? streetCards[name] : undefined,
      actions: (h.actions || [])
        .filter((a) => a.street === name)
        .map((a) => ({
          playerId: a.player_id,
          playerName: nameFor(a.player_id),
          /* The engine stores `all_in`; the panel's union says `allin`. This
             compared against `'all-in'`, a spelling nothing produces, so the
             conversion NEVER fired: every all-in reached the panel as the raw
             `all_in`, missed `getActionColor`'s case and printed the raw token
             into the exported hand text too. The service type now says
             `all_in`, which is what turned this from silence into a compiler
             error. */
          action: (a.action === 'all_in'
            ? 'allin'
            : a.action) as PanelHandRecord['streets'][number]['actions'][number]['action'],
          amount: a.amount,
          /* PHASE 4 COMPLETION 2026-09-01: the viewer's own thrown card, as a
             canonical code because that is the only card shape this panel
             renders. `toCardCode` because the store writes the suit as a WORD
             (`{rank:'9',suit:'hearts'}`) and taking the last character of that
             would print the nine of hearts as a spade - the exact bug that
             produced `UNDEFINE` on the board, see utils/cardCode.ts. Undefined
             on every other player's discard: the service only ever fills it
             for rows RLS let this viewer read. */
          discardedCard: a.discarded_card ? toCardCode(a.discarded_card) : undefined,
        })),
      pot: 0, // not stored per street — only the final pot is persisted
    }))
    .filter((s) => s.actions.length > 0 || s.cards);

  const potTotal = (h.main_pot || 0) + (h.side_pots || []).reduce((a, b) => a + (b || 0), 0);

  /* RUN IT TWICE — boards 2..N, and the reason Dan saw one board on a hand that
     ran three (production hand #3046089, 2026-08-27).

     `hand_history.rit_boards` was read correctly by HandHistoryService and
     landed on the service record; this adapter is the ONLY producer of the view
     model both hand-history screens render, and it did not carry the field
     across. The service knew and the screen never heard. Board 1 is not in here
     — it is the ordinary board and stays in `streets[].cards`, which is where
     `runBoardsFor` reads it from.

     Normalised through toCardCodes for the same reason community_cards is: the
     column stores spelled-out strings ("7clubs"), and a board that reaches the
     panel unparsed prints "UNDEFINE" beside a diamond. Empty runs are dropped
     rather than rendered as a blank RUN badge. */
  const ritBoards = (h.rit_boards || []).map((b) => toCardCodes(b)).filter((b) => b.length > 0);
  /* Bomb-pot boards 2 and 3, the same way. A double-board bomb pot rendered as
     ONE board here until 2026-09-04 because the adapter never carried them. */
  const bombBoards = [h.community_cards2, h.community_cards3]
    .map((b) => toCardCodes(b || []))
    .filter((b) => b.length > 0);

  /* TWO DIFFERENT MONEY FIGURES, and conflating them cost a player the truth
     about their own hand.

       COLLECTED = chips pushed from the pot to a winner (gross).
       RESULT    = collected minus everything that player put in (net).

     `winners[].amount` used to be set to `p.result`, i.e. the NET, while both
     its own type (HandHistoryService.HandWinner: "Chips taken from the pot.
     NOT the player's net result.") and every consumer treated it as gross.
     HandDetailModal then subtracted each action amount again and added this on
     top, so a hero who posted 2, called 10 and took a 24 pot was shown 0 in
     Hand Detail while Hand History showed +12 for the same hand. The gross was
     on the row the whole time, in `h.winners[].amount`, and was never read.

     Side pots arrive as one winner entry per pot for the same user, so they
     are summed rather than overwritten. */
  /* THE GROSS COMES FROM THE MODEL (2026-09-04 second sweep). This used to
     keep a legacy fallback that summed `actions[].amount` for what a player
     invested - the raise-TO bug handReplay.ts names this file for - so a row
     without a `winners` array over-stated every gross. `buildReplay` already
     differenced the same log correctly to produce `players[].won`; read that. */
  const collectedBy = new Map<string, number>();
  for (const w of h.winners || []) {
    if (!w?.user_id) continue;
    collectedBy.set(w.user_id, (collectedBy.get(w.user_id) || 0) + (Number(w.amount) || 0));
  }
  /* A row stored before `winners` was persisted still pins the gross exactly:
     result is `won - invested`, so `won = result + invested`, with `invested`
     taken from the model's differenced walk rather than a naive sum. */
  const investedBy = new Map<string, number>(replay.players.map((p) => [p.userId, p.invested]));
  const collectedFor = (uid: string, result: number): number =>
    collectedBy.has(uid)
      ? (collectedBy.get(uid) as number)
      : Math.round(((Number(result) || 0) + (investedBy.get(uid) || 0)) * 100) / 100;

  return {
    id: h.id,
    arenaAsset: h.arenaAsset,
    handNumber: h.hand_number,
    timestamp: Date.parse(h.played_at) || Date.now(),
    gameType: h.game_type,
    blinds: h.stakes,
    players: (h.players || []).map((p) => ({
      id: p.user_id,
      name: p.username,
      seat: p.seat,
      stack: 0, // not stored per hand in hand_history
      position: p.position,
      holeCards: toCardCodes(p.hole_cards).length ? toCardCodes(p.hole_cards) : undefined,
      /* Your own cards on a hand you did not show - only ever on the viewer's
         row (RLS), kept apart from `holeCards` because presence THERE is the
         table's reveal record. */
      privateHoleCards: toCardCodes(p.private_hole_cards || []).length
        ? toCardCodes(p.private_hole_cards || [])
        : undefined,
      /* The stored net, carried through instead of being re-derived downstream.
         HandDetailModal used to rebuild it from the action log and the winner
         amount, which is where the double subtraction lived. */
      result: Number(p.result) || 0,
    })),
    streets,
    /* From `h.winners` (the row's own list), not from `players[].is_winner`:
       a winner the roster does not carry (the settlement writer's own repair
       path logs exactly that case) used to be dropped here, and the pot index
       was lost. One entry per winner; side pots are summed. */
    winners: (() => {
      const seen = new Set<string>();
      const out: PanelHandRecord['winners'] = [];
      const resultOf = (uid: string) =>
        Number((h.players || []).find((p) => p.user_id === uid)?.result) || 0;
      for (const w of h.winners || []) {
        if (!w?.user_id || seen.has(w.user_id)) continue;
        seen.add(w.user_id);
        out.push({
          playerId: w.user_id,
          playerName: nameFor(w.user_id),
          amount: collectedFor(w.user_id, resultOf(w.user_id)),
          hand: (h.players || []).find((p) => p.user_id === w.user_id)?.final_hand ?? w.hand_name,
        });
      }
      // The roster flag covers rows written before `winners` was persisted.
      for (const p of h.players || []) {
        if (!p.is_winner || seen.has(p.user_id)) continue;
        seen.add(p.user_id);
        out.push({
          playerId: p.user_id,
          playerName: p.username,
          amount: collectedFor(p.user_id, p.result),
          hand: p.final_hand,
        });
      }
      return out;
    })(),
    heroId,
    heroResult: (h.players || []).find((p) => p.user_id === heroId)?.result ?? 0,
    potTotal,
    // Absent rather than empty on a single-run hand: `runBoardsFor` reads the
    // length, and an empty array is a claim that the hand ran once, not silence.
    ritBoards: ritBoards.length ? ritBoards : undefined,
    bombBoards: bombBoards.length ? bombBoards : undefined,
    winnersByBoard: (h.winners_by_board || []).length
      ? (h.winners_by_board || []).map((w) => ({
          board: w.board,
          playerId: w.user_id,
          playerName: nameFor(w.user_id),
          amount: w.amount,
          hand: w.hand_name,
          low: w.low === true,
        }))
      : undefined,
    /* A showdown is a card turning over. The persisted `showdown` record is
       the table's own account of that; a winner on a fold-around hand is not
       a showdown and must not be filed under one (Dan 2026-09-04). */
    wentToShowdown: (h.players || []).some(
      (p) => p.showdown_reveal !== undefined || (p.hole_cards && p.hole_cards.length > 0)
    ),
    muckedIds: (h.players || [])
      .filter((p) => p.showdown_reveal?.mucked === true)
      .map((p) => p.user_id),
    rake: Number(h.rake) || 0,
    bbjFee: Number(h.bbj_fee) || 0,
    tableName: h.table_name,
    /* The table's real seat count, for the tracker export's `N-max`. */
    tableMaxSeats: h.table_max_seats ?? null,
    bombPot: h.bomb_pot ?? null,
    /* Phase 2: the viewer's own all-in / EV facts, when the record has them. */
    heroFacts: (h.players || []).find((p) => p.user_id === heroId)?.facts,
    replay,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PANEL RECORD -> SHAREABLE HAND
   ═══════════════════════════════════════════════════════════════════════════

   Hand Detail's SHARE button had the same defect its REPLAY button had: the
   handler took no argument and shared `sharedHandData`, a snapshot built once
   at the end of the LIVE hand. Open Hand Detail, page back to an older hand,
   press SHARE, and you shared the most recent hand instead — or, if you had
   not finished a hand this session, you got "Play a hand to the end, then
   share it" while looking straight at a hand that was plainly finished.

   The record on screen already carries everything a share link needs, so the
   subject is built FROM IT rather than looked up again.

   Note what is deliberately NOT set: `stack`. Hand history does not store a
   per-hand stack (the adapter writes 0 above precisely because it is unknown),
   and HandHistoryPage once filled a literal 1000 for every seat, presenting an
   invented number to whoever opened the link. `ShareablePlayer.stack` is
   optional so the figure can be omitted; omitted is what an unknown is. */

/**
 * PHASE 4 2026-09-05 — THE SHARE LINK IS BUILT FROM THE MODEL.
 *
 * This function used to re-read the panel record street by street and assemble
 * a share payload of its own: its own verb table, its own board slicing, its
 * own winner list. That was a second reading of a hand the record had already
 * reconstructed, and it dropped what the second reading had no field for -
 * the run-it-twice boards, the hi-lo halves, the rake, the jackpot drop, the
 * discard street, the dead money and the hand number.
 *
 * `hand.replay` IS the reconstruction. `shareableFromModel` reads it, and the
 * recipient's `replayFromShareable` rebuilds it. The verb table and the card
 * parser that used to live here went with the second reading; `toShareVariant`
 * moved to `lib/shareHandModel` so the table and the archive share ONE
 * mapping (the table's copy knew four of the seven variants).
 */
export function panelHandToShareable(hand: PanelHandRecord, tableName: string): ShareableHand {
  return shareableFromModel(hand.replay, {
    id: hand.id,
    tableName: tableName || hand.tableName || 'Club Arena',
    heroUserId: hand.heroId,
  });
}
