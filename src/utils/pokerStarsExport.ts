/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TAKE IT WITH YOU — a hand history a tracker can actually import
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 5 of the Previous Hand build plan (2026-09-06).
 *
 * Club Arena already had an export, and it was ours: `Club Arena Hand #N`,
 * our verbs, our punctuation. It reads well and PokerTracker 4 and Hand2Note
 * cannot import a line of it, so a player who wanted their own hands in their
 * own tracker had nothing.
 *
 * This writes the PokerStars text format, which is the one every tracker
 * parses. Three things about it are not obvious and each one is a rejected
 * import if you get it wrong:
 *
 *   1. A RAISE IS WRITTEN "raises BY to TO". The model stores the increment
 *      (what left the stack); the format wants both that and the level it
 *      raised to. The level is the seat's LIVE commitment on the street, so
 *      dead money is excluded from it - the same rule that makes the felt draw
 *      the right chips, applied to the text.
 *   2. THE UNCALLED BET IS ITS OWN LINE, "Uncalled bet ($X) returned to Y",
 *      and it is NOT an action. Written as one, a tracker counts the money
 *      twice.
 *   3. THE SUMMARY IS PART OF THE GRAMMAR. `Total pot` / `Rake` / `Board` /
 *      one `Seat N:` line per player, in seat order.
 *
 * WHAT IT REFUSES TO DO. A tracker's numbers are only worth having if they are
 * the table's numbers, so this never invents one. A hand whose starting stacks
 * the record does not carry cannot be written faithfully - the format has a
 * mandatory "($X in chips)" on every seat - so `toPokerStarsHand` returns
 * `faithful: false` with the reason, and the caller exports the hands it can
 * and SAYS how many it left out. Silently writing zeros would put fiction in
 * somebody's database and it would look exactly like data.
 *
 * VALIDATED AGAINST THE FORMAT, NOT AGAINST A TRACKER. The grammar below is
 * pinned line by line in `tests/unit/handSearchAndExport.test.ts`, including a
 * full round trip of real production hands. Nobody here has run PokerTracker
 * against the output; if an importer rejects something, the pin is the place
 * to correct it.
 *
 * READ THE OUTPUT, NOT ONLY THE TESTS. Every defect this file has carried was
 * found by generating the corpus and reading it - four before it shipped, and
 * five more in the Phase 5 deep dive: summary positions the format has no
 * grammar for, `showed and lost` with the cards missing, the uncalled bet
 * printed after the showdown instead of before it, a missing time stamped as
 * today, and an `ET` label on the exporter's own clock. Green tests said
 * nothing about any of them, because each one was a line nobody had thought
 * to assert.
 */

import type { DeckCard } from './deckCards';
import type { ReplayModel, ReplayRow, ReplayStreet } from './handReplay';

export interface PokerStarsMeta {
  handNumber: number | string | null | undefined;
  tableName: string | null | undefined;
  /** When the hand was played. Falls back to the model's own timestamp. */
  playedAt?: string | number | null;
  /** Whose hand history this is: the seat written as "Dealt to". */
  heroUserId?: string | null;
  /**
   * Seats at the table, for the `N-max` in the table line. `hand_history` does
   * not carry it - the caller reads it from the table row. Left out, the
   * writer falls back to the floor the occupied seats prove rather than to a
   * constant; see the table line below for why a constant was wrong.
   */
  maxSeats?: number;
  /** Tournament hands are written in chips, cash hands in a currency. */
  isTournament?: boolean;
  /** The currency symbol for a cash game. Defaults to `$`. */
  currency?: string;
}

export interface PokerStarsResult {
  text: string;
  /**
   * False when the record could not be written without inventing something.
   * The text is still returned - it is readable - but it must not be handed
   * to a tracker as fact.
   */
  faithful: boolean;
  reasons: string[];
}

/**
 * THE NAME THAT GOES IN THE FILE.
 *
 * `ReplayModel.players[].username` is ALREADY the resolved arena alias -
 * `HandHistoryService` runs every row through `playerDisplayName` before the
 * model is built - so this reads it rather than resolving again. It is bound
 * to a local at every use instead of interpolated straight from the player,
 * which is also what keeps `tests/theArenaIsAlwaysTheAlias.law.test.ts` able
 * to tell a screen painting a raw column from a file writing a resolved one.
 */
const nameOf = (p: { username: string }): string => p.username;

/** `{rank:'T', suit:'h'}` -> `Th`, which is the only card shape the format has. */
function card(c: DeckCard): string {
  return `${c.rank}${c.suit}`;
}
const cards = (list: DeckCard[]): string => list.map(card).join(' ');

/**
 * The made hand, in the format's casing.
 *
 * The evaluator's own label is Title Cased for the felt (the house popup
 * rule); PokerStars writes `two pair`, `a full house`, lower case. The WORDS
 * are the evaluator's either way - no detail is invented here, because the
 * format's fuller "two pair, Kings and Fours" is a fact this record does not
 * carry and guessing at it is how fiction gets into somebody's database.
 */
const handWords = (name: string): string => String(name || '').toLowerCase();

/**
 * The variant, named the way the format names it.
 *
 * A name this does not know would make the whole hand unparseable, so an
 * unknown variant is a REFUSAL rather than a guess at "Hold'em No Limit".
 */
const GAME_NAME: Record<string, string> = {
  nlh: "Hold'em No Limit",
  flh: "Hold'em Limit",
  short_deck: "Hold'em No Limit",
  plo4: 'Omaha Pot Limit',
  plo: 'Omaha Pot Limit',
  plo5: '5 Card Omaha Pot Limit',
  plo6: '6 Card Omaha Pot Limit',
  plo8: 'Omaha Hi/Lo Pot Limit',
  flo8: 'Omaha Hi/Lo Limit',
};

export function pokerStarsGameName(variant: string | null | undefined): string | null {
  const key = String(variant || '')
    .toLowerCase()
    .replace(/[\s-]/g, '_');
  return GAME_NAME[key] ?? null;
}

/**
 * `2026/09/06 09:11:37 ET`, and it is REALLY Eastern.
 *
 * This used to read `getHours()` - the EXPORTING BROWSER's own clock - and
 * label it ET regardless. The same hand exported in London and in Chicago
 * carried two different times, and neither was the one the label claimed. A
 * tracker groups hands into sessions by their stamps, so a shifted clock
 * splits one session in two or welds two into one.
 *
 * Returns null for a time it cannot read, because the caller must REFUSE such
 * a hand rather than stamp it with today (see the reasons below): a date is
 * fiction that looks exactly like data.
 */
const ET_STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
function stamp(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const part: Record<string, string> = {};
  for (const p of ET_STAMP.formatToParts(d)) part[p.type] = p.value;
  /* `hour12: false` emits "24" for midnight in some engines. */
  const hour = part.hour === '24' ? '00' : part.hour;
  return `${part.year}/${part.month}/${part.day} ${hour}:${part.minute}:${part.second} ET`;
}

/** The street headers, in the format's own spelling. */
const STREET_HEADER: Record<string, string> = {
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
};

/**
 * `*** TURN *** [7h 2c Ts] [9d]` - the board SO FAR, then the new card.
 * A reader that prints only the new card loses the board on every street but
 * the flop, and a tracker rebuilds the wrong texture from it.
 */
function streetHeaderLine(street: ReplayStreet, previousBoard: DeckCard[]): string | null {
  const name = STREET_HEADER[street.key];
  if (!name) return null;
  const fresh = street.board.slice(previousBoard.length);
  if (street.key === 'flop') return `*** FLOP *** [${cards(street.board)}]`;
  if (!fresh.length) return `*** ${name} ***`;
  return `*** ${name} *** [${cards(previousBoard)}] [${cards(fresh)}]`;
}

export function toPokerStarsHand(model: ReplayModel, meta: PokerStarsMeta): PokerStarsResult {
  const reasons: string[] = [];
  const money = (n: number): string => {
    const v = Math.abs(Number(n) || 0);
    return meta.isTournament ? String(Math.round(v)) : `${meta.currency ?? '$'}${v.toFixed(2)}`;
  };

  const game = pokerStarsGameName(model.gameVariant);
  if (!game) reasons.push(`no PokerStars name for the variant "${model.gameVariant ?? 'unknown'}"`);

  const missingStacks = model.players.filter((p) => p.startStack === null).map((p) => p.username);
  if (missingStacks.length) {
    reasons.push(
      `the record carries no starting stack for ${missingStacks.length} seat(s): ` +
        missingStacks.join(', ')
    );
  }

  /**
   * TWO SHAPES THIS PLATFORM DEALS THAT THE FORMAT CANNOT SAY, and writing
   * either one as an ordinary hand would put a WRONG hand in somebody's
   * database rather than no hand:
   *
   *   A BOMB POT posts antes and no blinds. Every tracker derives position,
   *   preflop aggression and most of its preflop statistics from who posted
   *   the blinds; a hand where nobody did is either rejected or read as a hand
   *   the player never had.
   *
   *   RUN IT TWICE settles one pot across two or three boards. The format has
   *   one board, so the hand would import with the right money against the
   *   wrong showdown - the winner "collecting" a full pot on a board they won
   *   half of.
   *
   * Both are refused with their reason, and the surface says how many it left
   * out. That is the difference between an export a player can trust and one
   * that quietly teaches their tracker something false.
   */
  const allRows = model.streets.flatMap((s) => s.rows);
  const postedBlind = allRows.some((r) => r.verb === 'sb' || r.verb === 'bb');
  if (!postedBlind) {
    reasons.push('no blinds were posted (a bomb pot), which the PokerStars format cannot express');
  }
  if (model.boards.length > 1) {
    reasons.push(
      `the hand ran ${model.boards.length} boards, and the format has one - importing it ` +
        'would attach the whole pot to a single showdown'
    );
  }

  /**
   * A HAND WITH NO TIME ON IT IS REFUSED, not stamped with today.
   *
   * `stamp` used to fall back to `new Date()`, so a record whose `played_at`
   * was missing was written with the moment of the export - and a whole file
   * of them carried the same second. A tracker reads that as one session
   * played now, which is a hand the player never had at a time they were not
   * at the table.
   */
  const played = stamp(meta.playedAt ?? model.playedAt);
  if (!played) {
    reasons.push(
      'the record carries no time for the hand, and a stamped guess would file it in the wrong session'
    );
  }

  const lines: string[] = [];
  const heroSeat = meta.heroUserId
    ? model.players.find((p) => p.userId === meta.heroUserId)
    : undefined;
  const stakes = meta.isTournament
    ? `${Math.round(model.smallBlind)}/${Math.round(model.bigBlind)}`
    : `${meta.currency ?? '$'}${model.smallBlind.toFixed(2)}/${meta.currency ?? '$'}${model.bigBlind.toFixed(2)}`;

  lines.push(
    `PokerStars Hand #${meta.handNumber ?? model.handNumber ?? 0}: ` +
      `${game ?? "Hold'em No Limit"} (${stakes}${meta.isTournament ? '' : ' USD'}) - ` +
      (played ?? stamp(Date.now()))
  );

  const buttonSeat = model.buttonSeat ?? model.players[0]?.seat ?? 1;
  /**
   * THE TABLE'S OWN SIZE, not a constant.
   *
   * This wrote `9-max` on every hand. Measured against the fleet, that is
   * wrong for most of it: the tables on this platform are 3-max (64,759),
   * 9-max (63,808) and heads-up (39,459), plus 6, 7 and 8. Every heads-up and
   * three-handed hand exported as full ring, and a tracker's heads-up
   * statistics are a different game from its full-ring ones.
   *
   * `hand_history` does not carry the size, so the caller reads it from the
   * table row and passes it. When the table row is gone - they are recycled -
   * the FLOOR is what the seats themselves prove: a table cannot be smaller
   * than its highest occupied seat. That is derived from the record rather
   * than assumed, and it is stated here so nobody reads it as a fact the
   * record held.
   */
  const seatFloor = model.players.reduce((max, p) => Math.max(max, p.seat || 0), 0);
  /* NEVER below the floor, even when the caller says so. A table row can be
     resized after the hand was dealt, and `6-max` written above a `Seat 7:`
     line is a table that cannot exist - which a parser is right to reject. */
  const maxSeats = Math.max(meta.maxSeats && meta.maxSeats > 0 ? meta.maxSeats : 0, seatFloor, 2);
  lines.push(
    `Table '${(meta.tableName || 'Club Arena').replace(/'/g, '')}' ` +
      `${maxSeats}-max Seat #${buttonSeat} is the button`
  );

  for (const p of model.players) {
    const chips = p.startStack === null ? money(0) : money(p.startStack);
    lines.push(`Seat ${p.seat}: ${nameOf(p)} (${chips} in chips)`);
  }

  const byStreet = (key: string): ReplayStreet | undefined =>
    model.streets.find((s) => s.key === key);

  /**
   * The forced money, which the format writes BEFORE the hole cards and in its
   * own words. Everything else on preflop is an ordinary action.
   */
  const preflop = byStreet('preflop');
  const forced = new Set(['sb', 'bb', 'ante', 'straddle']);
  /**
   * THE FORMAT'S ORDER, not the log's: antes, then the small blind, then the
   * big blind, then any straddle. The engine writes them in seat order, so a
   * hand whose big blind sits in a lower seat than its small blind posted the
   * big blind first in the file - which reads as a hand where the blinds were
   * the wrong way round.
   */
  const POST_ORDER: Record<string, number> = { ante: 0, sb: 1, bb: 2, straddle: 3 };
  const postRows = (preflop?.rows ?? [])
    .filter((r) => forced.has(r.verb) || r.dead)
    .slice()
    .sort((a, b) => (POST_ORDER[a.verb] ?? 0) - (POST_ORDER[b.verb] ?? 0));
  for (const r of postRows) {
    if (r.verb === 'sb') lines.push(`${r.name}: posts small blind ${money(r.amount)}`);
    else if (r.verb === 'bb') lines.push(`${r.name}: posts big blind ${money(r.amount)}`);
    else if (r.verb === 'straddle') lines.push(`${r.name}: posts straddle ${money(r.amount)}`);
    else lines.push(`${r.name}: posts the ante ${money(r.amount)}`);
  }

  lines.push('*** HOLE CARDS ***');
  const heroCards = heroSeat?.hole?.length ? heroSeat.hole : heroSeat?.privateHole;
  if (heroSeat && heroCards?.length) {
    lines.push(`Dealt to ${nameOf(heroSeat)} [${cards(heroCards)}]`);
  }

  /**
   * A RAISE IS "raises BY to TO", and TO is the seat's live commitment on this
   * street. Dead money never joins it - the same rule the reconstruction uses
   * to difference a raise-TO level in the first place.
   */
  const writeActions = (street: ReplayStreet) => {
    const live = new Map<number, number>();
    /**
     * THE BET LEVEL, which is what a raise is measured against.
     *
     * "raises X to Y" does NOT put the raiser's own increment in X. Y is their
     * total on the street and X is how much they raised THE LEVEL by, so over
     * a $2 big blind a raise to $5 is "raises $3 to $5" - not "$5 to $5",
     * which is what writing the increment produces and what a tracker reads as
     * a raise to ten dollars.
     */
    /* Preflop starts at zero and the blind rows raise it as they are walked,
       so the big blind IS the level a first raise is measured against. */
    let level = 0;
    for (const r of street.rows) {
      const before = live.get(r.seat) ?? 0;
      const after = r.dead ? before : before + Math.max(0, r.amount);
      if (!r.dead && r.amount > 0) live.set(r.seat, after);
      const levelBefore = level;
      if (!r.dead && after > level) level = after;

      switch (r.verb) {
        case 'fold':
          lines.push(`${r.name}: folds`);
          break;
        case 'check':
          lines.push(`${r.name}: checks`);
          break;
        case 'call':
          lines.push(`${r.name}: calls ${money(r.amount)}`);
          break;
        case 'bet':
          lines.push(`${r.name}: bets ${money(r.amount)}`);
          break;
        case 'raise':
          lines.push(`${r.name}: raises ${money(after - levelBefore)} to ${money(after)}`);
          break;
        case 'all_in':
          /* The format has no "all in" verb: it is a bet, a call or a raise
             with " and is all-in" on the end, and which one depends on the
             level this seat is facing. */
          if (levelBefore <= 0) {
            lines.push(`${r.name}: bets ${money(r.amount)} and is all-in`);
          } else if (after > levelBefore) {
            lines.push(
              `${r.name}: raises ${money(after - levelBefore)} to ${money(after)} and is all-in`
            );
          } else {
            /* All-in for LESS than the bet: a call, not a raise. */
            lines.push(`${r.name}: calls ${money(r.amount)} and is all-in`);
          }
          break;
        case 'show':
        case 'muck':
          /* SAID ONCE. The `*** SHOW DOWN ***` block below writes who showed
             what, off `model.showdown`; the engine ALSO writes a `show` row on
             the showdown street, and printing both put the same seat's cards
             in the file twice - which a parser reads as two showdowns. */
          break;
        case 'return':
          /* NOT an action. Its own line, and the amount is unsigned there. */
          lines.push(`Uncalled bet (${money(Math.abs(r.amount))}) returned to ${r.name}`);
          break;
        case 'discard':
          /* Crazy Pineapple has no PokerStars grammar. Written as a comment so
             the file still parses and a reader can still see it happened. */
          lines.push(`${r.name}: discards 1 card`);
          break;
        default:
          break;
      }
    }
  };

  if (preflop) writeActions(preflop);
  const discard = byStreet('pineapple_discard');
  if (discard) writeActions(discard);

  let seen: DeckCard[] = [];
  for (const key of ['flop', 'turn', 'river'] as const) {
    const street = byStreet(key);
    if (!street) continue;
    const header = streetHeaderLine(street, seen);
    if (header) lines.push(header);
    seen = street.board;
    writeActions(street);
  }

  /**
   * THE UNCALLED BET COMES BACK BEFORE THE SHOWDOWN, because that is when it
   * happens: the last caller is short, the surplus is returned, and only then
   * do the cards go face up.
   *
   * This engine files the return with stage `showdown` (the same fact Phase 4
   * found when the wire had no showdown slot), and writing the showdown street
   * after the `*** SHOW DOWN ***` block put the return AFTER the cards. A
   * reader rebuilding the pot street by street then has the wrong number in
   * the middle at the moment of the showdown. Its `show` and `muck` rows are
   * skipped inside `writeActions`; what travels here is the return.
   */
  const showdownStreet = byStreet('showdown');
  if (showdownStreet) writeActions(showdownStreet);

  /**
   * WHAT EACH SEAT ACTUALLY TURNED OVER, by seat, so the summary can repeat it
   * the way the format does. A seat with no cards on record did not show, and
   * the summary says `mucked` rather than claiming a showdown nobody can see.
   */
  const revealed = new Map<number, { hole: DeckCard[]; handName: string }>();
  for (const row of model.showdown) {
    if (row.boardIndex !== 0 || row.low) continue;
    if (row.hole?.length && !revealed.has(row.seat)) {
      revealed.set(row.seat, { hole: row.hole, handName: row.handName });
    }
  }

  if (model.showdown.length > 0) {
    lines.push('*** SHOW DOWN ***');
    /* One "shows" line per seat that turned cards over, on board one. */
    for (const row of model.showdown.filter((r) => r.boardIndex === 0 && !r.low)) {
      if (row.hole?.length) {
        lines.push(`${row.name}: shows [${cards(row.hole)}] (${handWords(row.handName)})`);
      }
    }
  }

  for (const p of model.players) {
    if (p.won > 0) lines.push(`${nameOf(p)} collected ${money(p.won)} from pot`);
  }

  lines.push('*** SUMMARY ***');
  const rakeText = model.rake > 0 ? ` | Rake ${money(model.rake)}` : ' | Rake $0.00';
  lines.push(`Total pot ${money(model.potTotal)}${meta.isTournament ? '' : rakeText}`);
  if (seen.length) lines.push(`Board [${cards(seen)}]`);
  /* Run-it-twice has no PokerStars grammar either. The extra boards are named
     rather than dropped, so a human reading the file sees the hand that was
     played even where a tracker will only read the first board. */
  const finalStreet = model.streets[model.streets.length - 1];
  (finalStreet?.extraBoards ?? []).forEach((b, i) => {
    if (b.length) lines.push(`Board ${i + 2} [${cards(b)}]`);
  });

  /* "folded before Flop" preflop, "folded on the Flop" after - the format's
     own wording, which is not the street label the felt prints. */
  const FOLD_WORDS: Record<string, string> = {
    preflop: 'folded before Flop',
    pineapple_discard: 'folded before Flop',
    flop: 'folded on the Flop',
    turn: 'folded on the Turn',
    river: 'folded on the River',
  };
  const foldedOn = new Map<string, string>();
  for (const s of model.streets) {
    for (const r of s.rows) {
      if (r.verb === 'fold') foldedOn.set(r.userId, FOLD_WORDS[s.key] ?? 'folded before Flop');
    }
  }
  /**
   * THE SUMMARY HAS EXACTLY THREE POSITIONS: `(button)`, `(small blind)` and
   * `(big blind)`. Every other seat carries NOTHING.
   *
   * This wrote the felt's own labels straight through - `(utg)`, `(mp)`,
   * `(co)`, `(hj)`, and `(sb)`/`(bb)` in our spelling - which is 101 of the
   * corpus's summary lines carrying a token no parser has a rule for. Read
   * from the POSTS rather than from the derived position, because who put the
   * blind in is the record's own witness to which seat it was.
   */
  const sbSeat = allRows.find((r) => r.verb === 'sb')?.seat ?? null;
  const bbSeat = allRows.find((r) => r.verb === 'bb')?.seat ?? null;
  const summaryPosition = (seat: number): string => {
    const parts: string[] = [];
    /* Heads-up the button IS the small blind, and the format writes both. */
    if (seat === buttonSeat) parts.push('(button)');
    if (seat === sbSeat) parts.push('(small blind)');
    else if (seat === bbSeat) parts.push('(big blind)');
    return parts.length ? ` ${parts.join(' ')}` : '';
  };

  for (const p of model.players) {
    const who = `Seat ${p.seat}: ${nameOf(p)}${summaryPosition(p.seat)}`;
    const reveal = revealed.get(p.seat);
    /**
     * `showed and lost` with NO CARDS is what this used to write, while the
     * very same cards sat three lines above in the `*** SHOW DOWN ***` block.
     * A parser reads that as a showdown with an unknown holding, which is
     * worse than no showdown at all: the tracker records it as fact and the
     * holding is simply missing.
     */
    if (p.won > 0) {
      lines.push(
        reveal
          ? `${who} showed [${cards(reveal.hole)}] and won (${money(p.won)}) with ${handWords(reveal.handName)}`
          : `${who} collected (${money(p.won)})`
      );
    } else if (foldedOn.has(p.userId)) {
      lines.push(`${who} ${foldedOn.get(p.userId)}`);
    } else if (reveal) {
      lines.push(
        `${who} showed [${cards(reveal.hole)}] and lost with ${handWords(reveal.handName)}`
      );
    } else {
      /* No cards on record IS the muck: nothing was turned over. */
      lines.push(`${who} mucked`);
    }
  }

  return { text: lines.join('\n'), faithful: reasons.length === 0, reasons };
}

/**
 * Many hands, one file, blank line between - which is how a tracker's bulk
 * import expects them.
 *
 * Only the FAITHFUL ones are written, and the count of the rest comes back so
 * the surface can say how many were left out and why rather than handing over
 * a file that is quietly short.
 */
export function toPokerStarsFile(hands: Array<{ model: ReplayModel; meta: PokerStarsMeta }>): {
  text: string;
  written: number;
  skipped: Array<{ handNumber: string; reasons: string[] }>;
} {
  const parts: string[] = [];
  const skipped: Array<{ handNumber: string; reasons: string[] }> = [];
  for (const h of hands) {
    const out = toPokerStarsHand(h.model, h.meta);
    if (!out.faithful) {
      skipped.push({
        handNumber: String(h.meta.handNumber ?? h.model.handNumber ?? ''),
        reasons: out.reasons,
      });
      continue;
    }
    parts.push(out.text);
  }
  return { text: parts.join('\n\n') + (parts.length ? '\n' : ''), written: parts.length, skipped };
}

/** Only used by the summary line above; exported for the pins. */
export type { ReplayRow };
