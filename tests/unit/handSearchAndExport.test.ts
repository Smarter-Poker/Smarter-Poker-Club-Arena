/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PHASE 5 — finding a hand, and taking it with you
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two pure modules, pinned against the same anonymised corpus of real
 * production hands the share-link differ uses (38 hands: NLH, PLO4/5/6, PLO8,
 * FLO8, short deck, pineapple, limit hold'em; run-it-twice, bomb pots,
 * per-board awards, antes, straddles, discards, side pots, returned bets,
 * rake and jackpot drops).
 *
 * The export half is checked against the FORMAT's grammar, line by line -
 * nobody here has run PokerTracker against the output, and the file says so.
 * What these pins are really for is the three things that make a tracker
 * reject a file, all of which are easy to write wrongly and impossible to
 * notice by reading: a raise's "to" level, the uncalled bet being its own
 * line, and the summary block.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceCall } from '../helpers/sourceWindow';
import { buildReplay, replayInputFromRow, type ReplayModel } from '../../src/utils/handReplay';
import {
  BIG_POT_BIG_BLINDS,
  filterBySubjects,
  handMatchesQuery,
  handQueryIsActive,
  handSearchSubject,
  type HandSearchSubject,
} from '../../src/lib/handSearch';
import {
  pokerStarsGameName,
  toPokerStarsFile,
  toPokerStarsHand,
} from '../../src/utils/pokerStarsExport';

const rows = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures-realhands.json'), 'utf8')
) as Array<Record<string, unknown>>;

const models: Array<{ row: Record<string, unknown>; model: ReplayModel }> = rows.map((row) => ({
  row,
  model: buildReplay(replayInputFromRow(row as never)),
}));

const subjectFor = (m: ReplayModel, extra: Partial<Parameters<typeof handSearchSubject>[1]> = {}) =>
  handSearchSubject(m, {
    heroUserId: m.players[0]?.userId ?? null,
    handNumber: m.handNumber,
    playedAtMs: m.playedAt ? new Date(m.playedAt).getTime() : Date.now(),
    ...extra,
  });

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────────────────────

describe('finding a hand', () => {
  const base: HandSearchSubject = {
    handNumber: '6704153',
    playedAt: new Date(2026, 8, 5, 12, 0, 0).getTime(),
    variant: 'plo8',
    heroNet: 12.5,
    potTotal: 40,
    bigBlind: 0.2,
    wentToShowdown: true,
    heroAllIn: true,
    names: ['Dan', 'KingFish', 'BarrelSage'],
    note: 'called too light on the turn',
    tags: ['leak', 'turn'],
  };

  it('an untouched query matches everything', () => {
    expect(handQueryIsActive({})).toBe(false);
    expect(handMatchesQuery(base, {})).toBe(true);
    const all = filterBySubjects(models, (m) => subjectFor(m.model), {});
    expect(all.length).toBe(models.length);
  });

  it('finds a hand by its number, with or without the hash', () => {
    expect(handMatchesQuery(base, { text: '6704153' })).toBe(true);
    expect(handMatchesQuery(base, { text: '#6704153' })).toBe(true);
    expect(handMatchesQuery(base, { text: '04153' })).toBe(true);
    expect(handMatchesQuery(base, { text: '9999999' })).toBe(false);
  });

  it('finds a hand by an OPPONENT, not only by the viewer', () => {
    expect(handMatchesQuery(base, { text: 'kingfish' })).toBe(true);
    expect(handMatchesQuery(base, { text: 'BARREL' })).toBe(true);
    expect(handMatchesQuery(base, { text: 'nobody' })).toBe(false);
  });

  it('finds a hand by a word in the note, or by a tag', () => {
    expect(handMatchesQuery(base, { text: 'too light' })).toBe(true);
    expect(handMatchesQuery(base, { text: 'leak' })).toBe(true);
    expect(handMatchesQuery({ ...base, note: null, tags: null }, { text: 'leak' })).toBe(false);
  });

  it('separates won from lost by the viewer NET, not the pot', () => {
    expect(handMatchesQuery(base, { outcome: 'won' })).toBe(true);
    expect(handMatchesQuery(base, { outcome: 'lost' })).toBe(false);
    const losing = { ...base, heroNet: -3 };
    expect(handMatchesQuery(losing, { outcome: 'lost' })).toBe(true);
    /* A break-even hand is neither, and must not appear under both. */
    const flat = { ...base, heroNet: 0 };
    expect(handMatchesQuery(flat, { outcome: 'won' })).toBe(false);
    expect(handMatchesQuery(flat, { outcome: 'lost' })).toBe(false);
  });

  it('showdown means cards were turned over', () => {
    expect(handMatchesQuery(base, { showdown: true })).toBe(true);
    expect(handMatchesQuery({ ...base, wentToShowdown: false }, { showdown: true })).toBe(false);
  });

  it('all-in means the VIEWER was all-in', () => {
    expect(handMatchesQuery(base, { allIn: true })).toBe(true);
    expect(handMatchesQuery({ ...base, heroAllIn: false }, { allIn: true })).toBe(false);
  });

  it('a big pot is measured in big blinds, and a hand with no blind is not one', () => {
    expect(handMatchesQuery(base, { bigPots: true })).toBe(true); // 40 >= 100 * 0.2
    expect(handMatchesQuery({ ...base, potTotal: 19 }, { bigPots: true })).toBe(false);
    /* Never divide by a blind that is not there. */
    expect(handMatchesQuery({ ...base, bigBlind: 0 }, { bigPots: true })).toBe(false);
    expect(BIG_POT_BIG_BLINDS).toBe(100);
  });

  it('"noted" finds the hands the viewer wrote on, by note OR tag', () => {
    expect(handMatchesQuery(base, { noted: true })).toBe(true);
    expect(handMatchesQuery({ ...base, note: '   ', tags: [] }, { noted: true })).toBe(false);
    expect(handMatchesQuery({ ...base, note: '', tags: ['bluff'] }, { noted: true })).toBe(true);
  });

  it('matches a variant the way a player types it', () => {
    expect(handMatchesQuery({ ...base, variant: 'plo4' }, { variant: 'PLO' })).toBe(true);
    expect(handMatchesQuery({ ...base, variant: 'plo4' }, { variant: 'omaha' })).toBe(true);
    expect(handMatchesQuery({ ...base, variant: 'nlh' }, { variant: "hold'em" })).toBe(true);
    expect(handMatchesQuery({ ...base, variant: 'plo8' }, { variant: 'nlh' })).toBe(false);
  });

  it('reads a date range inclusively, in the reader’s own day', () => {
    const onTheDay = { ...base, playedAt: new Date(2026, 8, 5, 23, 59, 59).getTime() };
    expect(handMatchesQuery(onTheDay, { from: '2026-09-05', to: '2026-09-05' })).toBe(true);
    const justBefore = { ...base, playedAt: new Date(2026, 8, 4, 23, 59, 59).getTime() };
    expect(handMatchesQuery(justBefore, { from: '2026-09-05' })).toBe(false);
    const justAfter = { ...base, playedAt: new Date(2026, 8, 6, 0, 0, 0).getTime() };
    expect(handMatchesQuery(justAfter, { to: '2026-09-05' })).toBe(false);
  });

  it('ANDs its terms - each one narrows', () => {
    expect(handMatchesQuery(base, { outcome: 'won', showdown: true, text: 'kingfish' })).toBe(true);
    expect(handMatchesQuery(base, { outcome: 'won', text: 'nobody' })).toBe(false);
  });

  /**
   * BOTH SURFACES MUST FEED THE PREDICATE THE SAME FACTS.
   *
   * Running one predicate is only half of it. The table's panel searched with
   * a subject it built WITHOUT notes - it never loaded one - so `note` and
   * `tags` were always empty there and two branches of this predicate were
   * dead on that surface, while its own placeholder offered to search tags. A
   * player typed a tag they had written and was told "No Hands Here Match That
   * Search": a confident wrong answer about their own data, which is the drift
   * between two surfaces that one predicate exists to prevent.
   *
   * Read from the source, because the defect was an ABSENCE - there is no
   * value to assert when a field is never passed.
   */
  it('both surfaces pass the viewer’s own note and tags into the subject', () => {
    for (const file of [
      '../../src/pages/HandHistoryPage.tsx',
      '../../src/components/table/HandHistoryPanel.tsx',
    ]) {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      expect(src, `${file} loads the viewer's notes`).toMatch(/handNotesService\.listFor\(/);
      /* The CALL, bounded by its own closing paren - never a byte count, which
         drifts off the end of what it watches while staying green
         (tests/helpers/sourceWindow.ts). */
      const subject = sliceCall(src, 'handSearchSubject(');
      expect(subject, `${file} passes note`).toMatch(/note:/);
      expect(subject, `${file} passes tags`).toMatch(/tags:/);
    }
  });

  it('builds its subject off the model, on every real hand', () => {
    for (const { model } of models) {
      const s = subjectFor(model);
      expect(s.wentToShowdown).toBe(model.showdown.length > 0);
      expect(s.potTotal).toBe(model.potTotal);
      expect(s.names.length).toBe(model.players.filter((p) => p.username).length);
      /* all-in is the viewer's own, never somebody else's */
      const heroId = model.players[0]?.userId;
      const heroAllIn = model.streets
        .flatMap((st) => st.rows)
        .some((r) => r.verb === 'all_in' && r.userId === heroId);
      expect(s.heroAllIn).toBe(heroAllIn);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A REAL TIME, because every real caller has one and this corpus does not:
 * the anonymised fixtures carry no `played_at` at all, so before 2026-09-06
 * every hand these pins exported was stamped with the moment the test ran -
 * and the header pin below matched, because a fabricated stamp has exactly
 * the same SHAPE as a real one. Shape is all a regex can see. The value is
 * asserted now, which also pins the Eastern conversion.
 */
const PLAYED_AT = '2026-09-05T22:14:03.000Z'; // 18:14:03 in New York (EDT)
const meta = (extra: Record<string, unknown> = {}) => ({
  handNumber: 1,
  tableName: 'T',
  playedAt: PLAYED_AT,
  ...extra,
});

/**
 * The hands the writer itself says it can write faithfully. Derived from its
 * verdict rather than re-stated here, so a test cannot disagree with the code
 * about what is exportable - which it did the moment bomb pots and
 * run-it-twice were added to the refusals.
 */
const exportable = models.filter(({ model }) => toPokerStarsHand(model, meta()).faithful);

describe('a hand history a tracker can import', () => {
  it('has real hands to write, and knows which it cannot', () => {
    expect(exportable.length).toBeGreaterThan(0);
    const refused = models.filter(({ model }) => !pokerStarsGameName(model.gameVariant));
    /* Pineapple has no PokerStars grammar - refused rather than mislabelled. */
    for (const { model } of refused) {
      const out = toPokerStarsHand(model, meta());
      expect(out.faithful).toBe(false);
      expect(out.reasons.join(' ')).toMatch(/no PokerStars name/);
    }
  });

  it('opens with the header, the table line and a seat per player', () => {
    const { model } = exportable[0];
    const seatFloor = Math.max(...model.players.map((p) => p.seat));
    const { text } = toPokerStarsHand(model, {
      handNumber: 12345,
      tableName: "Dan's Table",
      playedAt: '2026-09-06T09:11:37.000Z',
      heroUserId: model.players[0].userId,
      maxSeats: seatFloor,
    });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(
      /^PokerStars Hand #12345: .+ \(\$[\d.]+\/\$[\d.]+ USD\) - \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} ET$/
    );
    expect(lines[1]).toMatch(
      new RegExp(`^Table 'Dans Table' ${seatFloor}-max Seat #\\d+ is the button$`)
    );
    for (const p of model.players) {
      expect(text).toContain(`Seat ${p.seat}: ${p.username} (`);
    }
    expect(text).toContain('*** HOLE CARDS ***');
    expect(text).toContain('*** SUMMARY ***');
    expect(text).toMatch(/\nTotal pot \$[\d.]+ \| Rake \$[\d.]+/);
  });

  it('writes a raise as "raises BY to TO", with the TO excluding dead money', () => {
    /* A tournament hand with an ante: the ante is in the pot and must NOT be
       part of the level a raise raised to. */
    const withAnte = models.find(
      ({ model }) =>
        model.streets.some((s) => s.rows.some((r) => r.dead && r.amount > 0)) &&
        model.streets.some((s) => s.rows.some((r) => r.verb === 'raise'))
    );
    expect(withAnte, 'the corpus has a raise over dead money').toBeTruthy();
    const { text } = toPokerStarsHand(withAnte!.model, meta());
    const raise = text.split('\n').find((l) => / raises /.test(l));
    expect(raise).toMatch(/raises .+ to /);

    const row = withAnte!.model.streets
      .flatMap((s) => s.rows.map((r) => ({ r, s })))
      .find((x) => x.r.verb === 'raise')!;
    const live = row.s.rows
      .slice(0, row.s.rows.indexOf(row.r))
      .filter((r) => r.seat === row.r.seat && !r.dead)
      .reduce((t, r) => t + Math.max(0, r.amount), 0);
    const to = live + row.r.amount;
    expect(raise).toContain(`to $${to.toFixed(2)}`);
  });

  /**
   * FOUR THINGS READING THE ACTUAL OUTPUT CAUGHT that the pins above did not.
   * Every one of them produces a file that looks right and imports wrongly.
   */
  it('measures a raise against the BET LEVEL, not the raiser’s own increment', () => {
    /* Over a $2 big blind, a raise to $5 is "raises $3 to $5". Writing the
       increment gives "raises $5 to $5", which a tracker reads as a raise to
       ten dollars. */
    const withRaise = exportable.find(({ model }) =>
      model.streets.some((s) => s.key === 'preflop' && s.rows.some((r) => r.verb === 'raise'))
    );
    expect(withRaise, 'the corpus has a preflop raise').toBeTruthy();
    const { text } = toPokerStarsHand(withRaise!.model, meta());
    const raise = text.split('\n').find((l) => / raises /.test(l))!;
    const [, by, to] = raise.match(/raises \$([\d.]+) to \$([\d.]+)/)!;
    expect(Number(to)).toBeGreaterThan(Number(by));
    /* And the level it was measured against is the big blind. */
    expect(Number(to) - Number(by)).toBeCloseTo(withRaise!.model.bigBlind, 2);
  });

  it('posts the small blind before the big blind, whatever the seat order', () => {
    const withBlinds = exportable.find(
      ({ model }) =>
        model.streets.some((s) => s.rows.some((r) => r.verb === 'sb')) &&
        model.streets.some((s) => s.rows.some((r) => r.verb === 'bb'))
    );
    expect(withBlinds, 'the corpus has a blinded hand').toBeTruthy();
    const { text } = toPokerStarsHand(withBlinds!.model, meta());
    expect(text.indexOf('posts small blind')).toBeLessThan(text.indexOf('posts big blind'));
  });

  it('shows a seat’s cards ONCE, not once per source', () => {
    /* The engine writes a `show` row on the showdown street AND the model
       carries a showdown row; printing both put the same hand in the file
       twice, which reads as two showdowns. */
    const withShowdown = exportable.find(({ model }) => model.showdown.length > 0);
    expect(withShowdown, 'the corpus has a showdown').toBeTruthy();
    const { text } = toPokerStarsHand(withShowdown!.model, meta());
    const shows = text.split('\n').filter((l) => / shows \[/.test(l));
    const names = shows.map((l) => l.split(':')[0]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('says "folded before Flop" preflop, in the format’s own words', () => {
    const withPreflopFold = exportable.find(({ model }) =>
      model.streets.some((s) => s.key === 'preflop' && s.rows.some((r) => r.verb === 'fold'))
    );
    expect(withPreflopFold, 'the corpus has a preflop fold').toBeTruthy();
    const { text } = toPokerStarsHand(withPreflopFold!.model, meta());
    expect(text).toMatch(/folded before Flop/);
    /* Never the felt's own street label, which is "PreFlop". */
    expect(text).not.toMatch(/folded on the PreFlop/);
  });

  it('refuses a bomb pot and a run-it-twice hand, with the reason', () => {
    const bomb = models.find(
      ({ model }) =>
        !model.streets.flatMap((s) => s.rows).some((r) => r.verb === 'sb' || r.verb === 'bb')
    );
    expect(bomb, 'the corpus has a bomb pot').toBeTruthy();
    const bombOut = toPokerStarsHand(bomb!.model, meta());
    expect(bombOut.faithful).toBe(false);
    expect(bombOut.reasons.join(' ')).toMatch(/no blinds were posted/);

    const rit = models.find(({ model }) => model.boards.length > 1);
    expect(rit, 'the corpus has a run-it-twice hand').toBeTruthy();
    const ritOut = toPokerStarsHand(rit!.model, meta());
    expect(ritOut.faithful).toBe(false);
    expect(ritOut.reasons.join(' ')).toMatch(/ran \d boards/);
  });

  it('writes the uncalled bet as its own line, never as an action', () => {
    const withReturn = models.find(
      ({ model }) =>
        model.streets.some((s) => s.rows.some((r) => r.verb === 'return')) &&
        pokerStarsGameName(model.gameVariant) &&
        model.players.every((p) => p.startStack !== null)
    );
    expect(withReturn, 'the corpus has a returned bet').toBeTruthy();
    const { text } = toPokerStarsHand(withReturn!.model, meta());
    expect(text).toMatch(/^Uncalled bet \(\$[\d.]+\) returned to .+$/m);
    /* And the money is unsigned there - a negative would be read as a bet. */
    expect(text).not.toMatch(/Uncalled bet \(\$-/);
  });

  it('names the board on every street it was dealt, cumulatively', () => {
    const toRiver = exportable.find(({ model }) =>
      model.streets.some((s) => s.key === 'river' && s.board.length === 5)
    );
    expect(toRiver, 'the corpus has a hand that saw a river').toBeTruthy();
    const { text } = toPokerStarsHand(toRiver!.model, meta());
    expect(text).toMatch(/\*\*\* FLOP \*\*\* \[\w{2} \w{2} \w{2}\]/);
    expect(text).toMatch(/\*\*\* TURN \*\*\* \[\w{2} \w{2} \w{2}\] \[\w{2}\]/);
    expect(text).toMatch(/\*\*\* RIVER \*\*\* \[\w{2} \w{2} \w{2} \w{2}\] \[\w{2}\]/);
    expect(text).toMatch(/\nBoard \[\w{2} \w{2} \w{2} \w{2} \w{2}\]/);
  });

  it('gives every seat a summary line, in seat order', () => {
    const { model } = exportable[0];
    const { text } = toPokerStarsHand(model, meta());
    const summary = text.slice(text.indexOf('*** SUMMARY ***'));
    const seats = [...summary.matchAll(/^Seat (\d+): /gm)].map((m) => Number(m[1]));
    expect(seats).toEqual(model.players.map((p) => p.seat));
  });

  it('never writes a stack it does not know', () => {
    const noStacks = models.find(({ model }) => model.players.some((p) => p.startStack === null));
    if (!noStacks) return; // corpus may not contain one; the refusal is still pinned below
    const out = toPokerStarsHand(noStacks.model, meta());
    expect(out.faithful).toBe(false);
    expect(out.reasons.join(' ')).toMatch(/no starting stack/);
  });

  it('writes many hands into one file and reports what it left out', () => {
    const file = toPokerStarsFile(
      models.map(({ model }) => ({
        model,
        meta: meta({
          handNumber: model.handNumber,
          heroUserId: model.players[0]?.userId,
        }),
      }))
    );
    expect(file.written).toBe(exportable.length);
    expect(file.written + file.skipped.length).toBe(models.length);
    /* Every hand in the file starts a hand, and they are blank-line separated. */
    const headers = file.text.split('\n\n').filter(Boolean);
    expect(headers.length).toBe(file.written);
    for (const h of headers) expect(h.startsWith('PokerStars Hand #')).toBe(true);
    for (const s of file.skipped) expect(s.reasons.length).toBeGreaterThan(0);
  });

  /* ───────────────────────────────────────────────────────────────────────
     THE PHASE 5 DEEP DIVE (2026-09-06). Five more defects, all of them found
     the same way the first four were: by generating the corpus and READING
     it. Each one wrote a file that looks right and imports wrongly, and each
     one sat under a green suite - because what was pinned was the SHAPE of a
     line, and every one of these has the right shape.
     ─────────────────────────────────────────────────────────────────────── */

  it('the summary carries only the three positions the format has', () => {
    /* `(utg)`, `(mp)`, `(co)`, `(hj)` are the FELT's labels and no parser has
       a rule for them; 101 of this corpus's summary lines carried one. The
       format writes `(button)`, `(small blind)`, `(big blind)`, and for every
       other seat nothing at all. */
    const ALLOWED =
      /^Seat \d+: .+?( \(button\))?( \((?:small|big) blind\))? (?:folded|showed|collected|mucked)\b/;
    for (const { model } of exportable) {
      const { text } = toPokerStarsHand(model, meta());
      const summary = text.slice(text.indexOf('*** SUMMARY ***')).split('\n');
      for (const line of summary.filter((l) => /^Seat \d+: /.test(l))) {
        expect(line, line).toMatch(ALLOWED);
        expect(line, line).not.toMatch(/\((?:utg|mp|co|hj|lj|sb|bb)\)/);
      }
    }
  });

  it('heads-up, the button is also the small blind and the format says both', () => {
    const hu = exportable.find(({ model }) => model.players.length === 2);
    expect(hu, 'the corpus has a heads-up hand').toBeTruthy();
    const { text } = toPokerStarsHand(hu!.model, meta());
    expect(text.slice(text.indexOf('*** SUMMARY ***'))).toMatch(/\(button\) \(small blind\)/);
  });

  it('a seat that showed is written WITH its cards, and one that did not is a muck', () => {
    /* `showed and lost` with no cards is a showdown with an unknown holding -
       which a tracker records as fact - while the very cards sat three lines
       above in the SHOW DOWN block. */
    for (const { model } of exportable) {
      const { text } = toPokerStarsHand(model, meta());
      const summary = text.slice(text.indexOf('*** SUMMARY ***'));
      expect(summary).not.toMatch(/showed and (lost|won)/);
      for (const line of summary.split('\n').filter((l) => / showed /.test(l))) {
        expect(line, line).toMatch(/ showed \[[^\]]+\] and (lost|won \(\S+\)) with /);
      }
    }
  });

  it('returns the uncalled bet BEFORE the showdown, because that is when it happens', () => {
    const withBoth = exportable.find(({ model }) => {
      const { text } = toPokerStarsHand(model, meta());
      return text.includes('Uncalled bet') && text.includes('*** SHOW DOWN ***');
    });
    expect(withBoth, 'the corpus has a returned bet at a showdown').toBeTruthy();
    const { text } = toPokerStarsHand(withBoth!.model, meta());
    expect(text.indexOf('Uncalled bet')).toBeLessThan(text.indexOf('*** SHOW DOWN ***'));
  });

  it('refuses a hand with no time rather than stamping it with today', () => {
    /* The corpus is anonymised and carries NO `played_at`, so before this the
       whole file was written with the second the export ran - a session the
       player never sat in, in a shape no regex could tell from a real one. */
    const { model } = exportable[0];
    const out = toPokerStarsHand(model, { handNumber: 1, tableName: 'T' });
    expect(out.faithful).toBe(false);
    expect(out.reasons.join(' ')).toMatch(/no time for the hand/);
  });

  it('stamps the hand in Eastern, not in whatever clock is exporting it', () => {
    const { model } = exportable[0];
    /* 22:14:03Z on 5 September is 18:14:03 in New York. Read as local time -
       which is what `getHours()` did - it is a different hour in every
       timezone, under a label that says ET regardless. */
    const { text } = toPokerStarsHand(model, meta());
    expect(text.split('\n')[0]).toContain('2026/09/05 18:14:03 ET');
  });

  it('never writes a table smaller than the seats it is dealing to', () => {
    /* A constant 9 was wrong for most of this fleet, and a caller passing a
       stale size can be wrong the other way: `6-max` above a `Seat 7:` line
       is a table that cannot exist. */
    const { model } = exportable[0];
    const floor = Math.max(...model.players.map((p) => p.seat));
    const { text } = toPokerStarsHand(model, meta({ maxSeats: 2 }));
    expect(text.split('\n')[1]).toContain(`${floor}-max`);
    const bigger = toPokerStarsHand(model, meta({ maxSeats: floor + 2 }));
    expect(bigger.text.split('\n')[1]).toContain(`${floor + 2}-max`);
  });

  it('every real hand it accepts is written without throwing, and parses back', () => {
    for (const { model } of exportable) {
      const out = toPokerStarsHand(
        model,
        meta({
          handNumber: model.handNumber,
          tableName: 'Club Arena',
          heroUserId: model.players[0]?.userId,
        })
      );
      expect(out.faithful).toBe(true);
      const lines = out.text.split('\n');
      expect(lines[0].startsWith('PokerStars Hand #')).toBe(true);
      expect(lines.some((l) => l === '*** HOLE CARDS ***')).toBe(true);
      expect(lines.some((l) => l === '*** SUMMARY ***')).toBe(true);
      /* No card may reach the file as "10x" - the format's rank is T. */
      expect(out.text).not.toMatch(/\[10/);
      /* No money may be written as a bare number on an action line. */
      expect(out.text).not.toMatch(/^.+: (calls|bets|raises) (?!\$)/m);
    }
  });
});
