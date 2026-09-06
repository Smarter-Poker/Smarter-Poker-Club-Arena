/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REPLAY FRAMES — the animated replay, one step at a time, off the one model
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-04 (Previous Hand second sweep). The replayer used to build its own
 * timeline from the raw action list: it dropped the blinds (so every replayed
 * pot was short by SB + BB), added raise-TO levels on top of what the seat had
 * already committed (over-counting every raised street), never advanced the
 * board on a street with no actions (an all-in froze the felt on the flop),
 * and switched the board on the STEP index as if it were a street index - so
 * step 2 of a fourteen-step hand showed the flop during pre-flop action, and
 * every step from 5 on showed the river.
 *
 * This walks `ReplayModel`, the single reconstruction every hand surface
 * renders, and emits one frame per thing that happened: the deal, each street
 * as it was turned, each action, the showdown. Pot, bets, stacks and the board
 * on every frame are the model's own figures; nothing is recomputed here.
 */

import type { DeckCard } from './deckCards';
import type { ReplayModel, ReplayRow } from './handReplay';
import { money } from './handFormat';

export interface ReplayFrame {
  key: string;
  /** Which street the frame belongs to. */
  streetKey: string;
  streetLabel: string;
  /** Board one, face-up as of this frame. */
  board: DeckCard[];
  /** Extra boards (run-it-twice, bomb pot), each sliced to this frame's street. */
  extraBoards: DeckCard[][];
  /** Chips in the middle after this frame (the model's running pot). */
  pot: number;
  /** Chips each seat has committed on the CURRENT street; cleared on a new street. */
  committed: Record<number, number>;
  /** Stack per seat after this frame; null where the model could not say. */
  stacks: Record<number, number | null>;
  /** Seats that have folded so far. */
  folded: number[];
  /** Seats whose cards are face-up so far (a `show` row, or the showdown). */
  revealed: number[];
  /** The seat that acted on this frame, or null on a deal / street / showdown frame. */
  activeSeat: number | null;
  /** The row this frame plays, or null. */
  row: ReplayRow | null;
  /** One line for the caption strip: "Flop 7c 2c 9h", "kingfish Raise 12.00". */
  caption: string;
  /** True on the last frame: every board out, the winners lit. */
  isShowdown: boolean;
}

const money2 = (n: number) => Math.round(n * 100) / 100;

function cardText(cards: DeckCard[]): string {
  return cards
    .map((c) => `${String(c.rank).toUpperCase().replace('10', 'T')}${String(c.suit).charAt(0)}`)
    .join(' ');
}

/** The seats that were dealt in, from the model's roster. */
export function frameSeats(model: ReplayModel): number[] {
  return model.players.map((p) => Number(p.seat)).filter((s) => Number.isFinite(s) && s > 0);
}

export function buildReplayFrames(model: ReplayModel): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  const seats = frameSeats(model);
  const committed: Record<number, number> = {};
  const stacks: Record<number, number | null> = {};
  const folded = new Set<number>();
  const revealed = new Set<number>();
  let pot = 0;

  for (const p of model.players) {
    committed[p.seat] = 0;
    stacks[p.seat] = p.startStack;
  }

  const snap = (
    partial: Pick<
      ReplayFrame,
      'key' | 'streetKey' | 'streetLabel' | 'board' | 'extraBoards' | 'caption'
    > &
      Partial<Pick<ReplayFrame, 'activeSeat' | 'row' | 'isShowdown'>>
  ): ReplayFrame => ({
    ...partial,
    pot: money2(pot),
    committed: { ...committed },
    stacks: { ...stacks },
    folded: [...folded],
    revealed: [...revealed],
    activeSeat: partial.activeSeat ?? null,
    row: partial.row ?? null,
    isShowdown: partial.isShowdown ?? false,
  });

  const fullBoard = model.boards[0] || [];
  const fullExtra = model.boards.slice(1);

  frames.push(
    snap({
      key: 'deal',
      streetKey: 'preflop',
      streetLabel: 'Deal',
      board: [],
      extraBoards: fullExtra.map(() => []),
      caption: `${seats.length} Players Dealt In`,
    })
  );

  for (const street of model.streets) {
    const isShowdownStreet = street.key === 'showdown';
    if (!isShowdownStreet && street.key !== 'preflop') {
      // A new street: the board turns, the street's bets sweep into the pot.
      for (const s of Object.keys(committed)) committed[Number(s)] = 0;
      frames.push(
        snap({
          key: `street-${street.key}`,
          streetKey: street.key,
          streetLabel: street.label,
          board: street.board,
          extraBoards: street.extraBoards,
          caption: street.newCards.length
            ? `${street.label} ${cardText(street.newCards)}`
            : street.label,
        })
      );
    }
    for (const row of street.rows) {
      const seat = Number(row.seat);
      pot = money2(pot + row.amount);
      /* DEAD forced money (an ante, a bomb-pot ante, the dead half of a dead
         blind) is in the POT and never in front of the seat. Counting it as a
         commitment drew a tournament big blind with 750 in front when 400 was
         live, and Phase 3's pot odds then priced every call off that number.
         The reconstruction has always known which rows are dead; since
         2026-09-05 it says so on the row (`ReplayRow.dead`). */
      if (row.amount !== 0 && !isShowdownStreet && !row.dead) {
        committed[seat] = money2((committed[seat] || 0) + row.amount);
      }
      if (row.stackAfter !== null) stacks[seat] = row.stackAfter;
      if (row.verb === 'fold' || row.verb === 'muck') folded.add(seat);
      if (row.verb === 'show' && row.shownCards?.length) revealed.add(seat);
      const amt = row.amount !== 0 ? ` ${money(Math.abs(row.amount))}` : '';
      frames.push(
        snap({
          key: `row-${row.key}`,
          streetKey: street.key,
          streetLabel: street.label,
          board: isShowdownStreet ? fullBoard : street.board,
          extraBoards: isShowdownStreet ? fullExtra : street.extraBoards,
          caption: `${row.name} ${row.label}${amt}`,
          activeSeat: seat,
          row,
        })
      );
    }
  }

  // The last frame: every board out, every shown hand up, the pot as awarded.
  for (const s of Object.keys(committed)) committed[Number(s)] = 0;
  for (const r of model.showdown) if (r.hole && !r.holePrivate) revealed.add(Number(r.seat));
  // The stack after settlement is the one figure the row stores directly.
  for (const p of model.players)
    if (p.stack !== null && p.stack !== undefined) stacks[p.seat] = p.stack;
  const winners = model.showdown.filter((r) => r.isWinner && r.boardIndex === 0 && !r.low);
  const winnerNames = [...new Set(winners.map((r) => r.name))];
  const takenBy =
    winnerNames.length > 0
      ? winnerNames.join(', ')
      : [...new Set(model.players.filter((p) => p.won > 0).map((p) => p.username))].join(', ');
  frames.push(
    snap({
      key: 'showdown',
      streetKey: 'showdown',
      streetLabel: model.showdown.length > 0 ? 'Showdown' : 'Result',
      board: fullBoard,
      extraBoards: fullExtra,
      caption: takenBy
        ? `${takenBy} ${winnerNames.length > 1 || takenBy.includes(',') ? 'Split' : 'Takes'} ${model.pots
            .map((p) => `${p.label} ${money(p.amount)}`)
            .join(', ')}`
        : 'Hand Complete',
      isShowdown: true,
    })
  );

  return frames;
}
