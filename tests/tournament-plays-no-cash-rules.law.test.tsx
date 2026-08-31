/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT TABLE PLAYS NO CASH RULES — LAW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, quoted in ServerTableEngineBase.applyRunItTwiceConfig: "run it twice or
 * 3 times is a cash game only area. it should never be in MTT, SPINS OR HEADS
 * UP." The same reasoning holds for every other cash-only money rule, and each
 * one below is a bug that was really live or really latent on 2026-08-31:
 *
 *   - the Game Rules modal lit the RUN IT TWICE chip on EVERY table in the
 *     product, because it read `runItTwice ?? true` off a TableState field
 *     that was declared and never assigned;
 *   - the same modal printed a cash rake ("10% (Cap X)") on tournament tables,
 *     whose pots the engine rakes at exactly zero;
 *   - it printed Min/Max Buy-In as 0 / 0, the literal columns a tournament
 *     table is created with;
 *   - it described the HERO's auto-straddle enrolment as the TABLE's straddle
 *     rule;
 *   - the engine posted a straddle on `straddle_enabled` alone, with no
 *     tournament gate;
 *   - the seven-deuce bounty moved table chips on `seven_deuce_enabled` alone,
 *     with no tournament gate — in a tournament that is a transfer outside the
 *     elimination and payout model;
 *   - the bomb pot fired on `bomb_pot_enabled` alone — a forced ante nobody's
     blind level owes, differing table to table inside one event;
   - and, the mirror of the run-it-twice lie, the Insurance chip was DARK on
     every table in the product because nothing ever passed the prop, so a cash
     table that genuinely offers insurance denied it at the felt;
   - late-reg/rebuy EXPANSION tables were built without `allow_rabbit_hunt`,
 *     so they ignored the tournament's own setting that the tables built at
 *     start honour.
 *
 * Measured against production the same day: 105,078 tournament table rows, of
 * which run_it_twice/allow_run_it_twice true on ALL of them and the legacy
 * run_it_twice_enabled true on 28,651 — so the COLUMNS can never be read as
 * intent for a tournament. straddle_enabled, seven_deuce_enabled,
 * insurance_enabled and bomb_pot_enabled are true on 0 of them, which is the
 * only reason the server leaks were latent rather than live.
 *
 * If a pin here goes red you are putting a cash rule back on a tournament
 * felt, or telling a tournament player about one that will never happen.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GameRulesModal } from '../src/components/table/GameRulesModal';
import { sliceCall } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../', p), 'utf8');
const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
const BASE = read('server/src/engine/ServerTableEngineBase.ts');
const SEATING = read('server/src/engine/ServerTableEngineSeating.ts');
const TURNS = read('server/src/engine/ServerTableEngineTurns.ts');
const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
const TOURNEY_MGR = read('server/src/tournament/TournamentManager.ts');
const TOURNEY_BASE = read('server/src/tournament/TournamentManagerBase.ts');
const MODALS = read('src/components/table/TableModalsLayer.tsx');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const BOMB_SCHED = read('server/src/engine/BombPotScheduler.ts');

/** Every cash-only feature turned ON at the props level, so the ONLY thing
 *  that can switch them off in the assertions below is the tournament gate. */
const everythingOn = {
  isOpen: true,
  onClose: () => {},
  variant: "No Limit Hold'em",
  stakes: '500/1000',
  minBuyIn: 0,
  maxBuyIn: 0,
  rakePercentage: 10,
  rakeCap: 6,
  isStraddleEnabled: true,
  isRunItTwiceEnabled: true,
  isInsuranceEnabled: true,
  bombPotRules: {
    enabled: true,
    frequency: 10,
    anteBB: 2,
    doubleBoard: false,
  },
};

const openTableInfo = () => {
  fireEvent.click(screen.getByText('Table Info'));
};

/* By class, not by text: on a cash table the Bomb Pot disclosure section
   below the chips carries an <h3> with the same words. */
const chip = (label: string): HTMLElement => {
  const texts = [...document.querySelectorAll('.rules-modal__feature-text')];
  const match = texts.find((n) => (n.textContent || '').trim() === label);
  expect(match, `no feature chip labelled ${label}`).toBeTruthy();
  return (match as HTMLElement).parentElement as HTMLElement;
};

describe('the Game Rules modal tells a tournament player the truth', () => {
  it('no cash-only feature chip is active on a tournament table', () => {
    render(<GameRulesModal {...everythingOn} isTournament />);
    openTableInfo();
    for (const label of ['Straddle', 'Run It Twice', 'Insurance', 'Bomb Pot']) {
      expect(chip(label).className).not.toContain('rules-modal__feature--active');
    }
    cleanup();
  });

  it('the same chips DO light on a cash table — the gate is the tournament flag, not a deletion', () => {
    render(<GameRulesModal {...everythingOn} isTournament={false} />);
    openTableInfo();
    for (const label of ['Straddle', 'Run It Twice', 'Insurance', 'Bomb Pot']) {
      expect(chip(label).className).toContain('rules-modal__feature--active');
    }
    cleanup();
  });

  it('rake reads None on a tournament table — the engine takes zero', () => {
    render(<GameRulesModal {...everythingOn} isTournament />);
    openTableInfo();
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.queryByText('10% (Cap 6)')).toBeNull();
    cleanup();
  });

  it('rake still reads the cash schedule on a cash table', () => {
    render(<GameRulesModal {...everythingOn} isTournament={false} />);
    openTableInfo();
    expect(screen.getByText('10% (Cap 6)')).toBeTruthy();
    cleanup();
  });

  it('a tournament table shows no buy-in rows — a tournament seat is bought at registration', () => {
    render(<GameRulesModal {...everythingOn} isTournament />);
    openTableInfo();
    expect(screen.queryByText('Min Buy-In')).toBeNull();
    expect(screen.queryByText('Max Buy-In')).toBeNull();
    cleanup();
  });

  it('a cash table still shows its buy-in rows', () => {
    render(<GameRulesModal {...everythingOn} isTournament={false} />);
    openTableInfo();
    expect(screen.getByText('Min Buy-In')).toBeTruthy();
    expect(screen.getByText('Max Buy-In')).toBeTruthy();
    cleanup();
  });
});

describe('the modal is fed facts, not defaults', () => {
  it('run-it-twice is never coalesced to true', () => {
    expect(MODALS).not.toContain('runItTwice ?? true');
    expect(MODALS).toContain('isRunItTwiceEnabled={runItTwice === true}');
  });

  it('the modal is told whether this is a tournament', () => {
    expect(MODALS).toContain('isTournament={isTournament}');
  });

  it('the dead TableState.runItTwice field is gone and nothing reads it', () => {
    expect(TABLE_PAGE).not.toContain('tableState.runItTwice');
    expect(TABLE_PAGE).not.toMatch(/^\s*runItTwice\?: boolean;/m);
  });

  it('TablePage computes run-it-twice with the engine predicate, tournament gate first', () => {
    expect(TABLE_PAGE).toContain('const ritIsTournament =');
    expect(TABLE_PAGE).toContain('!ritIsTournament &&');
    expect(TABLE_PAGE).toContain('run_it_twice_enabled ?? false');
    // and it actually selects the columns it reasons about
    expect(TABLE_PAGE).toContain('run_it_twice, allow_run_it_twice, run_it_twice_enabled');
  });

  it("the Straddle chip reads the TABLE's rule, not the hero's enrolment", () => {
    expect(TABLE_PAGE).toContain('isStraddleEnabled={tableStraddleEnabled}');
  });

  it('the Insurance chip is actually fed — it was dark on every table', () => {
    expect(MODALS).toContain('isInsuranceEnabled={isInsuranceEnabled}');
    expect(TABLE_PAGE).toContain('isInsuranceEnabled={tableInsuranceEnabled}');
    expect(TABLE_PAGE).toContain('run_it_twice_enabled, insurance_enabled');
  });
});

describe('the engine refuses cash-only money rules on a tournament table', () => {
  it('no straddle is posted at a tournament table', () => {
    expect(DEALING).toContain('if (this.tableInfo.straddle_enabled && !this.isTournamentTable())');
  });

  it('no straddle engine is even configured for a tournament table', () => {
    expect(BASE).toContain('if (this.tableInfo.straddle_enabled && !this.isTournamentTable())');
  });

  it('straddle enrolment is refused at a tournament table', () => {
    expect(SEATING).toContain('if (!this.tableInfo?.straddle_enabled || this.isTournamentTable())');
  });

  it('the horse brain is not told a tournament table can straddle', () => {
    expect(TURNS).toContain(
      'straddleActive: this.tableInfo?.straddle_enabled === true && !this.isTournamentTable()'
    );
  });

  it('the seven-deuce bounty never moves tournament chips', () => {
    expect(SETTLEMENT).toContain(
      '(this.tableInfo as any)?.seven_deuce_enabled === true && !this.isTournamentTable()'
    );
  });

  it('no bomb pot is scheduled at a tournament table', () => {
    /* The single normalizer both readers go through — the deal-time decision
       and the snapshot pill — so they can never disagree. */
    expect(BOMB_SCHED).toContain(
      "const isTournament = !!t.tournament_id || t.game_type === 'tournament';"
    );
    expect(BOMB_SCHED).toContain(
      'enabled: (t.bomb_pot_enabled ?? false) && modeViable && !isTournament,'
    );
  });

  it('the manual bomb-pot claim carries its own tournament gate', () => {
    /* It reads bomb_pot_enabled directly rather than the normalized settings,
       because a host may keep bombs manual-only with no viable schedule. */
    const condition = sliceCall(DEALING, 'if (\n        !decision.isBombPot');
    expect(condition).toContain('this.tableInfo.bomb_pot_enabled === true');
    expect(condition).toContain('!this.isTournamentTable()');
  });

  it('run it twice keeps its tournament gate ahead of every column', () => {
    expect(BASE).toContain('!ritIsTournament &&');
    expect(BASE).toContain('&& !ritIsTournament');
  });
});

describe('an expansion table is the same table as one built at the start', () => {
  it('expansion tables carry the tournament rabbit-hunt rule', () => {
    expect(TOURNEY_MGR).toContain(
      'allow_rabbit_hunt: this.tournamentCache?.allow_rabbit_hunt !== false'
    );
    expect(TOURNEY_BASE).toContain('allow_rabbit_hunt: tournament.allow_rabbit_hunt !== false');
  });

  it('the two table-creation payloads set the same column set', () => {
    /* The two inserts drift apart silently — allow_rabbit_hunt was added to
       one of them on 2026-08-25 and missed the other for six days. Compare the
       keys, not the values: the values legitimately differ (the start payload
       builds at blind level 1, an expansion table joins at the CURRENT level,
       and it reads the cached tournament row rather than the argument). */
    const keysOf = (src: string, marker: string) => {
      const at = src.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf('})', at));
      return new Set([...body.matchAll(/^\s{10}([a-z_]+):/gm)].map((m) => m[1]));
    };
    const startKeys = keysOf(TOURNEY_BASE, ".from('tables')\n        .insert({");
    const expansionKeys = keysOf(TOURNEY_MGR, ".from('tables')\n        .insert({");
    expect(startKeys.size).toBeGreaterThan(10);
    expect([...startKeys].filter((k) => !expansionKeys.has(k))).toEqual([]);
    expect([...expansionKeys].filter((k) => !startKeys.has(k))).toEqual([]);
  });
});
