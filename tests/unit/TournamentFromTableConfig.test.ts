/**
 * THE SNG / MTT TABS MUST PRODUCE A TOURNAMENT (2026-08-19).
 *
 * Those tabs used to insert a row into `tables` exactly like the Regular tab,
 * producing an ordinary cash game with the configured blinds. Every tournament
 * control on them — buy-in, blind structure, payouts, starting chips, late
 * registration, rebuys, add-ons, bounty — wrote a `tables` column that nothing
 * in server/src reads, and the page reported "Table created and started!".
 *
 * This file pins the mapping into a real TournamentConfig. The assertions are
 * chosen around the things the tournament engine will refuse or mis-run:
 *
 *   - max_players must be POSITIVE. fn_register_for_tournament refuses entry
 *     when current_players >= max_players, so 0 means nobody can ever register.
 *   - an SNG only starts when FULL, so min must equal max or it sits in
 *     REGISTERING until the stale-SNG sweeper cancels and refunds it.
 *   - payouts must total 100 and must pay fewer places than the field size.
 *   - blinds must never decrease across playing levels.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTournamentConfig,
  canRunAsTournament,
  type TournamentFormInput,
} from '../../src/lib/tournamentFromTableConfig';
import { SPIN_TIERS } from '../../src/config/spinSpec';
import { describeMttStructure } from '../../server/src/tournament/mttStructureDescription';

const base: TournamentFormInput = {
  name: 'Friday Major',
  gameMode: 'mtt',
  buyIn: 50,
  startingChips: 10000,
  blindStructure: 'standard',
  blindsUpMinutes: 8,
  payoutStructure: 'payout1',
  sngPlayerCount: 9,
  isSpins: false,
  minPlayers: 10,
  maxPlayersRange: 100,
  lateRegistrationLevel: 6,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  koBounty: false,
  startTime: '',
};

describe('field size', () => {
  it('an MTT uses the configured range', () => {
    const c = buildTournamentConfig(base, 'nlh');
    expect(c.maxPlayers).toBe(100);
    expect(c.minPlayers).toBe(10);
  });

  it('an SNG has min equal to max, or it can never start', () => {
    const c = buildTournamentConfig({ ...base, gameMode: 'sng', sngPlayerCount: 18 }, 'nlh');
    expect(c.maxPlayers).toBe(18);
    expect(c.minPlayers).toBe(18);
  });

  it('never produces a zero or negative field', () => {
    const c = buildTournamentConfig({ ...base, maxPlayersRange: 0, minPlayers: 0 }, 'nlh');
    expect(c.maxPlayers).toBeGreaterThan(0);
    expect(c.minPlayers).toBeGreaterThanOrEqual(2);
  });
});

describe('payouts', () => {
  it('always total 100', () => {
    for (const field of [9, 18, 27, 100, 300]) {
      const c = buildTournamentConfig({ ...base, maxPlayersRange: field }, 'nlh');
      const total = c.payoutStructure.reduce((s, p) => s + p.percentage, 0);
      expect(Math.abs(total - 100)).toBeLessThanOrEqual(0.01);
    }
  });

  it('pay fewer places than the field, so the bubble can exist', () => {
    for (const field of [9, 18, 27, 100, 300]) {
      const c = buildTournamentConfig({ ...base, maxPlayersRange: field }, 'nlh');
      expect(c.payoutStructure.length).toBeLessThan(c.maxPlayers);
    }
  });

  it('winner-take-all is exactly one place at 100%', () => {
    const c = buildTournamentConfig({ ...base, payoutStructure: 'winner_take_all' }, 'nlh');
    expect(c.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
  });

  it('always includes place 1 — without it the winner takes the whole pool', () => {
    const c = buildTournamentConfig(base, 'nlh');
    expect(c.payoutStructure.some((p) => p.place === 1)).toBe(true);
  });
});

describe('blind structure', () => {
  it.each(['standard', 'slow'])(
    'keeps explicit stack and clock independent from the %s ramp name',
    (blindStructure) => {
      const input = { ...base, blindStructure, startingChips: 1000, blindsUpMinutes: 3 };
      const before = JSON.stringify(input);
      const config = buildTournamentConfig(input, 'nlh');
      const description = describeMttStructure(
        config.blindStructure.map((row) => ({
          durationMinutes: row.durationMinutes,
          bigBlind: row.bigBlind,
          isBreak: Boolean(row.isBreak),
        })),
        config.startingStack
      );
      expect(description).toMatchObject({
        startingDepthBB: 50,
        speedLabel: 'Turbo',
        openingMinutes: 3,
        minimumMinutes: 3,
        maximumMinutes: 3,
      });
      expect(config.startingStack).toBe(1000);
      expect(JSON.stringify(input)).toBe(before);
    }
  );

  it('applies the level length to playing levels and leaves breaks alone', () => {
    const c = buildTournamentConfig({ ...base, blindsUpMinutes: 12 }, 'nlh');
    const playing = c.blindStructure.filter((l) => !l.isBreak);
    expect(playing.length).toBeGreaterThan(0);
    for (const lvl of playing) expect(lvl.durationMinutes).toBe(12);
  });

  it('never lets blinds decrease — the service rejects that', () => {
    const c = buildTournamentConfig(base, 'nlh');
    const playing = c.blindStructure.filter((l) => !l.isBreak);
    for (let i = 1; i < playing.length; i++) {
      expect(playing[i].bigBlind).toBeGreaterThanOrEqual(playing[i - 1].bigBlind);
    }
  });

  it('every level has a positive duration', () => {
    const c = buildTournamentConfig({ ...base, blindsUpMinutes: 0 }, 'nlh');
    for (const lvl of c.blindStructure) expect(lvl.durationMinutes).toBeGreaterThan(0);
  });

  it('a spin uses the spin ramp and the placeholder tier ladder', () => {
    /* Was "and is winner-take-all", pinning a hard-coded [{1, 100}]. A Spin is
       NOT winner-take-all by definition — 25x and above pay 80 / 12 / 8 across
       all three seats. The creation-time ladder is the PLACEHOLDER tier's,
       read from SPIN_TIERS, because the real tier is drawn at start and
       writing it here would leak the multiplier to the lobby. Same value as
       before; it is now derived from the spec instead of asserted about it. */
    const c = buildTournamentConfig(
      { ...base, gameMode: 'sng', isSpins: true, sngPlayerCount: 3 },
      'nlh'
    );
    expect(c.type).toBe('spin');
    expect(c.maxPlayers).toBe(3);
    expect(c.payoutStructure).toEqual(
      SPIN_TIERS[0].payouts.map((pct, i) => ({
        place: i + 1,
        percentage: Math.round(pct * 10000) / 100,
      }))
    );
    // And it must never exceed the seats — the rule both the RPC and
    // tournaments_creation_guard now enforce as `>`.
    expect(c.payoutStructure.length).toBeLessThanOrEqual(c.maxPlayers);
  });
});

describe('money', () => {
  it('the fee is 10% of the buy-in, to the cent', () => {
    /**
     * Dan 2026-08-25 SUPERSEDES the whole-chip rule this test used to pin.
     * "FRACTIONAL FEE'S NEED TO BE ALLOWED, WE HAVE 1 BUY IN, 5 BUY IN'S ETC
     * THOSE SHOULD BE .10 RAKE AND .50 RAKE PER BUY IN."
     *
     * The old note said a fractional fee "made the total non-integer and the DB
     * CHECK refused the INSERT". Both halves of that are addressed rather than
     * worked around: the fee is cut OUT of the price, so a 33 buy-in is
     * 29.70 + 3.30 and the TOTAL is still exactly 33; and the CHECK that
     * hard-coded floor() to whole chips was relaxed by migration
     * 20260825_tournament_fees_may_be_fractional, which still refuses anything
     * over a tenth.
     */
    expect(buildTournamentConfig({ ...base, buyIn: 50 }, 'nlh').rake).toBe(5);
    expect(buildTournamentConfig({ ...base, buyIn: 33 }, 'nlh').rake).toBe(3.3);
    expect(buildTournamentConfig({ ...base, buyIn: 1 }, 'nlh').rake).toBe(0.1);
    expect(buildTournamentConfig({ ...base, buyIn: 5 }, 'nlh').rake).toBe(0.5);
    for (const buyIn of [1, 5, 15, 25, 33, 50, 99, 100, 250]) {
      const c = buildTournamentConfig({ ...base, buyIn }, 'nlh');
      // The PRICE stays whole; only the split has cents.
      expect(Number.isInteger(c.buyIn)).toBe(true);
      expect(c.buyIn).toBe(buyIn);
      expect(c.rake).toBe(Number(c.rake.toFixed(2)));
      expect(c.rake).toBeGreaterThan(0);
      expect(c.rake).toBeLessThanOrEqual(buyIn * 0.1 + 1e-9);
    }
  });

  it('a bounty tournament leaves something for the prize pool', () => {
    const c = buildTournamentConfig({ ...base, koBounty: true, buyIn: 50 }, 'nlh');
    expect(c.type).toBe('bounty');
    const bounty = c.bountyConfig!.baseBounty;
    expect(bounty).toBeGreaterThan(0);
    // buy-in minus the 10% fee minus the bounty must stay positive, or
    // fn_tournament_entry_split refuses every registration.
    expect(c.buyIn - c.rake - bounty).toBeGreaterThan(0);
  });
});

describe('start time', () => {
  it('is passed through for an MTT when it is in the future', () => {
    const future = new Date(Date.now() + 3_600_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    const c = buildTournamentConfig({ ...base, startTime: local }, 'nlh');
    expect(c.startTime).toBeInstanceOf(Date);
  });

  it('is dropped when it is in the past — that trips the auto-cancel', () => {
    const c = buildTournamentConfig({ ...base, startTime: '2020-01-01T12:00' }, 'nlh');
    expect(c.startTime).toBeUndefined();
  });

  it('is ignored for an SNG, which starts when it fills', () => {
    const c = buildTournamentConfig(
      { ...base, gameMode: 'sng', startTime: '2999-01-01T12:00' },
      'nlh'
    );
    expect(c.startTime).toBeUndefined();
  });
});

describe('payout structure choice (2026-08-22)', () => {
  it('payout1/2/3 pay ~10/12.5/15% of a 100-player field', () => {
    const places = (choice: string) =>
      buildTournamentConfig({ ...base, maxPlayersRange: 100, payoutStructure: choice }, 'nlh')
        .payoutStructure.length;
    // These used to all fall through to autoSelectPayouts, making the four
    // choices identical. Now the choice is honoured.
    expect(places('payout1')).toBe(10);
    expect(places('payout2')).toBe(13);
    expect(places('payout3')).toBe(15);
  });

  it('each choice still totals 100 and pays fewer places than the field', () => {
    for (const choice of ['payout1', 'payout2', 'payout3', 'winner_take_all']) {
      for (const field of [4, 9, 50, 300]) {
        const c = buildTournamentConfig(
          { ...base, maxPlayersRange: field, payoutStructure: choice },
          'nlh'
        );
        const total = c.payoutStructure.reduce((s, p) => s + p.percentage, 0);
        expect(Math.abs(total - 100)).toBeLessThanOrEqual(0.01);
        expect(c.payoutStructure.length).toBeLessThan(c.maxPlayers);
      }
    }
  });
});

describe('hyper turbo (2026-08-22)', () => {
  it('maps to a real hyper ramp instead of aliasing to turbo', () => {
    const bigBlinds = (structure: string) =>
      buildTournamentConfig({ ...base, blindStructure: structure }, 'nlh')
        .blindStructure.filter((l) => !l.isBreak)
        .map((l) => l.bigBlind);
    const hyper = bigBlinds('hyper_turbo');
    const turbo = bigBlinds('turbo');
    expect(hyper.join(',')).not.toBe(turbo.join(','));
    // Steeper jumps: the hyper ramp ends far above the turbo ramp.
    expect(hyper[hyper.length - 1]).toBeGreaterThan(turbo[turbo.length - 1]);
    // Still monotone, so the service accepts it.
    for (let i = 1; i < hyper.length; i++) {
      expect(hyper[i]).toBeGreaterThanOrEqual(hyper[i - 1]);
    }
  });
});

describe('parity fields (2026-08-22)', () => {
  it('carries the shared toggles into the tournament config', () => {
    const c = buildTournamentConfig(
      {
        ...base,
        isVipOnly: true,
        banChat: true,
        allInOrFold: true,
        labelAsNew: true,
        hideClubName: true,
        featuredTournament: true,
        bigBlindAnte: true,
        authorizedToRegister: true,
        synchronizedBreaks: false,
        shortDescription: '  Sunday special  ',
      },
      'nlh'
    );
    expect(c.isVipOnly).toBe(true);
    expect(c.banChat).toBe(true);
    expect(c.allInOrFold).toBe(true);
    expect(c.labelAsNew).toBe(true);
    expect(c.hideClubName).toBe(true);
    expect(c.isFeatured).toBe(true);
    expect(c.bigBlindAnte).toBe(true);
    expect(c.authorizedToRegister).toBe(true);
    expect(c.synchronizedBreaks).toBe(false);
    expect(c.shortDescription).toBe('Sunday special');
  });

  it('clamps action time and table size to the server ranges', () => {
    const c = buildTournamentConfig({ ...base, actionTimeSeconds: 999, tableSize: 99 }, 'nlh');
    expect(c.actionTimeSeconds).toBe(60);
    // Still 10. The tournament path is bound by the DECK, not by the cash seat
    // cap — tableSeating's header is explicit that tournaments are exempt from
    // that law, because it is kept tight for Run It Twice and a tournament
    // cannot run it twice. Hold'em deals two cards, so ten seats fit easily.
    expect(c.tableSize).toBe(10);

    const low = buildTournamentConfig({ ...base, actionTimeSeconds: 1, tableSize: 1 }, 'nlh');
    expect(low.actionTimeSeconds).toBe(5);
    expect(low.tableSize).toBe(2);
  });

  it('never builds a table the deck cannot deal', () => {
    // PLO6 deals six cards a seat, so a ten-handed table wants 60 hole cards
    // plus a board out of 52 and PokerEngine.deal() throws rather than dealing
    // short. These are the PHYSICAL limits, not the cash seat caps: plo4 is
    // 8-max for cash but a tournament may seat 10 of them, because the cash cap
    // exists to leave room for Run It Twice and a tournament cannot run twice.
    expect(buildTournamentConfig({ ...base, tableSize: 99 }, 'plo6').tableSize).toBe(7);
    expect(buildTournamentConfig({ ...base, tableSize: 99 }, 'plo5').tableSize).toBe(9);
    expect(buildTournamentConfig({ ...base, tableSize: 99 }, 'plo4').tableSize).toBe(10);
    expect(buildTournamentConfig({ ...base, tableSize: 99 }, 'short_deck').tableSize).toBe(10);
  });

  it('MTT-only fields never leave an SNG', () => {
    const c = buildTournamentConfig(
      {
        ...base,
        gameMode: 'sng',
        sngPlayerCount: 9,
        multiDayMtt: true,
        totalDays: 3,
        earlyBirdRegistration: true,
        earlyBirdChips: 500,
        restartTournamentEvery: true,
        restartEveryMinutes: 30,
        finalTableDeal: true,
        bubbleProtection: true,
        acceleratedMtt: true,
      },
      'nlh'
    );
    expect(c.isMultiDay).toBe(false);
    expect(c.totalDays).toBeUndefined();
    expect(c.earlyBirdEnabled).toBe(false);
    expect(c.restartEveryMinutes).toBeUndefined();
    expect(c.finalTableDealEnabled).toBe(false);
    expect(c.bubbleProtection).toBe(false);
    expect(c.acceleratedMtt).toBe(false);
  });

  it('a 2-player SNG is a real heads-up: min = max = table size = 2', () => {
    const c = buildTournamentConfig({ ...base, gameMode: 'sng', sngPlayerCount: 2 }, 'nlh');
    expect(c.maxPlayers).toBe(2);
    expect(c.minPlayers).toBe(2);
    expect(c.tableSize).toBe(2);
  });

  it('custom rebuy and add-on costs override the buy-in, whole numbers only', () => {
    const c = buildTournamentConfig(
      {
        ...base,
        numberOfRebuysReentries: 2,
        customRebuyReentryCost: true,
        rebuyReentryCost: 25,
        addOnMultiplier: 1.5,
        customAddOn: true,
        customAddOnCost: 40,
        addOnBreakLengthMinutes: 5,
      },
      'nlh'
    );
    expect(c.rebuyCost).toBe(25);
    expect(c.addOnCost).toBe(40);
    expect(c.addonBreakMinutes).toBe(5);
    expect(c.maxRebuys).toBe(2);
    expect(c.maxReentries).toBe(2);
    // Without the custom toggles the costs default to the buy-in total.
    const plain = buildTournamentConfig(
      { ...base, numberOfRebuysReentries: 2, addOnMultiplier: 1 },
      'nlh'
    );
    expect(plain.rebuyCost).toBe(plain.buyIn);
    expect(plain.addOnCost).toBe(plain.buyIn);
  });

  /* 2026-08-26: this test used to assert `isMultiDay: true` and a totalDays
     clamp of 7. Both were replaced deliberately, not broken. Multi-day has no
     day end, no Day 2 resume and no flight merge anywhere in the engine, so
     carrying the flag meant badging an event Multi-Day and then running it as
     a one-session freezeout. The flag is now refused at the database
     (trg_tournaments_refuse_unbuilt_multi_day) and never composed here, so
     what this test pins is the REFUSAL. The clamp assertions for the three
     features that do work are kept exactly as they were. */
  it('restart, early bird and GTD carry with their clamps', () => {
    const c = buildTournamentConfig(
      {
        ...base,
        multiDayMtt: true,
        totalDays: 99,
        restartTournamentEvery: true,
        restartEveryMinutes: 3,
        earlyBirdRegistration: true,
        earlyBirdChips: 750,
        gtdPrizePool: true,
        gtdPrizeAmount: 5000,
      },
      'nlh'
    );
    // Multi-day is refused, not carried, however loudly the config asks.
    expect(c.isMultiDay).toBe(false);
    expect(c.totalDays).toBeUndefined();
    expect(c.restartEveryMinutes).toBe(5); // clamped to the server's 5-1440
    expect(c.earlyBirdEnabled).toBe(true);
    expect(c.earlyBirdChips).toBe(750);
    expect(c.guaranteedPrize).toBe(5000);
  });

  it('next-step satellite with a target becomes a real satellite', () => {
    const c = buildTournamentConfig(
      {
        ...base,
        nextStepSatellite: true,
        satelliteTargetId: '11111111-1111-1111-1111-111111111111',
        satelliteSeats: 3,
      },
      'nlh'
    );
    expect(c.type).toBe('satellite');
    expect(c.satelliteTarget).toEqual({
      tournamentId: '11111111-1111-1111-1111-111111111111',
      seatsAwarded: 3,
    });
    // Without a target the toggle is inert - never a cash-paying "satellite".
    const noTarget = buildTournamentConfig({ ...base, nextStepSatellite: true }, 'nlh');
    expect(noTarget.type).toBe('mtt');
    expect(noTarget.satelliteTarget).toBeUndefined();
  });
});

describe('game variant', () => {
  /**
   * 2026-08-24: these two used to assert `canRunAsTournament('plo')` and
   * `('shortdeck')`. Those are the keys the MAP was written with — they are not
   * ids the create-table screen has ever emitted, which sends `plo4` and
   * `short_deck`. So the test agreed with the map, the map disagreed with the
   * screen, and neither knew: the SNG/MTT tabs were hidden on every game except
   * Hold'em while production ran 5,634 PLO and Short Deck tournaments made by
   * the recurring service. A test keyed to the implementation instead of to the
   * caller cannot catch that. These are now keyed to what the screen emits.
   */
  it('only offers tournaments for variants the engine can deal', () => {
    /* LIMIT JOINED THE LIST ON 2026-08-31, and this assertion moved with it in
       the same commit rather than being left asserting the old rule.
       `flh` / `flo8` used to be pinned false here on the reasoning that "limit
       escalates on a bet-size ladder and every blind structure here is a blind
       ladder". That is not how this engine works: `fixedLimitBetSize` derives
       the bet ladder FROM the big blind, and the tournament engine rewrites the
       table's blinds on every level, so a blind ladder IS the limit ladder. See
       src/config/tournamentVariants for the full argument. */
    for (const v of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'flh', 'flo8']) {
      expect(canRunAsTournament(v)).toBe(true);
    }
    // Pineapple still has no tournament path for its discard street.
    for (const v of ['pineapple', 'mixed', 'ofc']) {
      expect(canRunAsTournament(v)).toBe(false);
    }
    // And the dead keys must not answer true, or the bug returns quietly.
    for (const v of ['plo', 'shortdeck', 'flo']) expect(canRunAsTournament(v)).toBe(false);
  });

  it('maps to the engine vocabulary', () => {
    expect(buildTournamentConfig(base, 'plo4').gameVariant).toBe('PLO4');
    expect(buildTournamentConfig(base, 'plo5').gameVariant).toBe('PLO5');
    expect(buildTournamentConfig(base, 'plo6').gameVariant).toBe('PLO6');
    expect(buildTournamentConfig(base, 'plo8').gameVariant).toBe('PLO8');
    expect(buildTournamentConfig(base, 'short_deck').gameVariant).toBe('SHORT_DECK');
    expect(buildTournamentConfig(base, 'flh').gameVariant).toBe('FLH');
    expect(buildTournamentConfig(base, 'flo8').gameVariant).toBe('FLO8');
    expect(buildTournamentConfig(base, undefined).gameVariant).toBe('NLH');
  });
});

/**
 * THE SPIN CATALOGUE (2026-08-31).
 *
 * Spin & Go sells four games. Before this, the create-table form would happily
 * build a Short Deck or PLO8 Spin, and the Spins tab of the lobby filter had no
 * chip for either — so ticking any Games chip deleted that Spin from the board
 * with nothing to bring it back. The option is gone from the form; this pins
 * the INDEPENDENT refusal, which is what a restored draft or a saved template
 * carrying `isSpins: true` actually hits.
 */
describe('spin catalogue', () => {
  const spinBase = { ...base, gameMode: 'sng' as const, isSpins: true, sngPlayerCount: 3 };

  it('builds a Spin for the four games Spin & Go sells', () => {
    for (const v of ['nlh', 'plo4', 'plo5', 'plo6']) {
      expect(buildTournamentConfig(spinBase, v).type).toBe('spin');
      expect(buildTournamentConfig(spinBase, v).spinType).toBe('standard');
    }
  });

  it('downgrades a Spin the catalogue does not sell to a plain Sit & Go', () => {
    for (const v of ['plo8', 'short_deck', 'flh', 'flo8']) {
      const cfg = buildTournamentConfig(spinBase, v);
      expect(cfg.type).toBe('sng');
      // ...and it must not keep the Spin's fingerprints, or it would be a Spin
      // wearing a Sit & Go label.
      expect(cfg.spinType).toBeUndefined();
    }
  });
});
