/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE HEADS-UP BOARD: A MISSING SHAPE, A MISSING COLUMN, A MISSING WINDOW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three defects found on 2026-08-27, all in code that READ correct and RAN
 * wrong. Each one is pinned here at the source, in the house style of
 * spinEngineWiring and spinReserveOwnership, because none of them can be
 * asserted by importing the service: TournamentRecurringService constructs a
 * Supabase client at module load and RakebackSettlerService schedules a timer.
 *
 *  1. HEADS-UP TURBO DID NOT EXIST. The comment above SNG_BOARD_SHAPES said
 *     "THE STARTING STACK 300 FOR TURBO AND 1000 FOR DEEP STACK" and the array
 *     declared ONE shape, `turbo: false`. Because the flag was a compile-time
 *     false, the ` Turbo` suffix in the name template was unreachable dead
 *     code. Live: 5,283 heads-up events at 1,500 chips (legacy), 4,988 at
 *     1,000, and ZERO at 300.
 *
 *  2. TABLE_SIZE WAS NEVER WRITTEN. The column is NOT NULL DEFAULT 9, and
 *     TournamentBrainContext derived the format from it first, so 10,271
 *     heads-up rows claimed nine seats and every duel resolved to 'mtt'. The
 *     horses played two-handed poker with ICM and bubble ranges.
 *
 *  3. THE PAYOUT SWEEP COULD NOT REACH ITS BACKLOG. That applying repair has
 *     since been retired by the atomic place-settlement cutover. The root path
 *     now pays the complete frozen plan or none, so a daemon must never restore
 *     this second writer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HEADS_UP_SEATS, HEADS_UP_STACKS } from '../../src/config/headsUpSpec';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const recurring = read('server/src/services/TournamentRecurringService.ts');
const recurringCode = stripComments(recurring);
const scheduled = stripComments(read('server/src/services/ScheduledTournamentService.ts'));
const settler = stripComments(read('server/src/services/RakebackSettlerService.ts'));
const brain = stripComments(read('server/src/services/TournamentBrainContext.ts'));
const atomicSettlementMigration = stripComments(
  read('supabase/migrations/20260907205918_tournament_places_settle_and_complete_atomically.sql')
);

describe('1. the Heads-Up board offers BOTH bands', () => {
  const shapes = recurringCode.slice(
    recurringCode.indexOf('const SNG_BOARD_SHAPES'),
    recurringCode.indexOf('const SNG_BOARD_VARIANTS')
  );

  it('declares a turbo shape at all', () => {
    expect(shapes).toMatch(/turbo:\s*true/);
  });

  it('gives the turbo Dan-s 300 stack and the deep stack its 1000', () => {
    /**
     * 2026-08-31 (Phase 3): the numbers moved into src/config/headsUpSpec.ts,
     * so this follows them there rather than being deleted. The guarantee is
     * unchanged and now stronger -- the literal is asserted against the spec,
     * and the board is asserted to read the spec, so a change to either side
     * alone fails.
     */
    expect(HEADS_UP_STACKS.turbo).toBe(300);
    expect(HEADS_UP_STACKS.deep).toBe(1000);
    expect(shapes).toMatch(/turbo:\s*true,\s*startingStack:\s*HEADS_UP_STACKS\.turbo/);
    expect(shapes).toMatch(/turbo:\s*false,\s*startingStack:\s*HEADS_UP_STACKS\.deep/);
  });

  it('keeps both bands two-handed', () => {
    expect(HEADS_UP_SEATS).toBe(2);
    // The type annotation says `seats: number`; only the DECLARATIONS count.
    const seatDecls = shapes.match(/seats:\s*(?:\d+|HEADS_UP_SEATS)/g) ?? [];
    expect(seatDecls.length).toBe(2);
    for (const d of seatDecls) expect(d).toBe('seats: HEADS_UP_SEATS');
  });

  it('makes the " Turbo" name suffix reachable, so the two boards differ', () => {
    // ensureBoardOpen decides what to open by NAME. Two shapes that produced
    // the same string would mean one band permanently satisfying the other and
    // never being opened -- the same self-sustaining wedge that left thirty of
    // thirty-two Spin price points dead for fifteen hours.
    expect(recurringCode).toMatch(/shape\.turbo\s*\?\s*' Turbo'\s*:\s*''/);
    const names = new Set<string>();
    for (const shape of [
      { label: 'Heads-Up', turbo: false },
      { label: 'Heads-Up', turbo: true },
    ]) {
      for (const v of ['NLH', 'PLO4']) {
        for (const buyIn of [1, 2, 5, 10, 20, 25, 50, 100]) {
          names.add(`${v} ${shape.label} ${buyIn}${shape.turbo ? ' Turbo' : ''}`);
        }
      }
    }
    expect(names.size).toBe(32);
  });

  it('runs ONE blind ladder across both bands, on purpose', () => {
    // Dan 2026-08-23: "SPEED SHOULDN'T CHANGE, ONLY THE STARTING STACK." At
    // 10/20 the turbo opens at 15bb and the deep stack at 50bb; that IS the
    // difference. A second ladder would be a second thing to keep in agreement.
    expect(recurringCode).toMatch(/blindStructure:\s*BLIND_STRUCTURES\.HEADS_UP_3MIN/);
  });
});

describe('2. a game that fits at one table says so', () => {
  it('createSNG writes table_size from its own seat count', () => {
    const createSng = recurringCode.slice(
      recurringCode.indexOf('private async createSNG'),
      recurringCode.indexOf('private async createSpin')
    );
    expect(createSng).toMatch(/table_size:/);
    expect(createSng).toMatch(
      /table_size:\s*Math\.min\(10,\s*Math\.max\(2,\s*Number\(config\.maxPlayers\)/
    );
  });

  it('createSpin writes the three seats a Spin has by definition', () => {
    const createSpin = recurringCode.slice(recurringCode.indexOf('private async createSpin'));
    expect(createSpin).toMatch(/table_size:\s*SPIN_SEATS/);
  });

  it('the scheduled path stops defaulting a single-table game to nine seats', () => {
    expect(scheduled).not.toMatch(/table_size:\s*clampInt\(cfg\.tableSize,\s*2,\s*10,\s*9\)/);
    expect(scheduled).toMatch(
      /isSng\s*\|\|\s*isSpin\s*\?\s*Math\.min\(10,\s*Math\.max\(2,\s*maxPlayers\)\)/
    );
    expect(scheduled).toMatch(/row\.table_size\s*=\s*3/);
  });

  it('the derivation no longer trusts either column on its own', () => {
    // `table_size ?? max_players ?? 9` made the second operand unreachable,
    // because ?? falls through on NULL and the column is NOT NULL DEFAULT 9.
    expect(brain).not.toMatch(/row\.table_size\s*\?\?\s*row\.max_players/);
    expect(brain).toMatch(/export function seatsAtOneTable/);
    expect(brain).toMatch(/Math\.min\(\.\.\.asserted\)/);
  });
});

describe('3. one rate decides the fee, and every writer asks it', () => {
  it('the recurring service asks rakeRateFor instead of holding the rule', () => {
    expect(recurringCode).toMatch(
      /rakeRateFor\(\{\s*tournamentType:\s*'SNG',\s*maxPlayers:\s*config\.maxPlayers\s*\}\)/
    );
    // The old constant survives as a DERIVED name, never as a second literal.
    expect(recurringCode).not.toMatch(/SNG_RAKE_RATE\s*=\s*0\.05/);
    expect(recurringCode).toMatch(/SNG_RAKE_RATE\s*=\s*rakeRateFor\(/);
  });

  it('THE MONEY BUG: the scheduled path no longer splits at the bare default', () => {
    // This one writes buy_in_amount / buy_in_fee DIRECTLY, bypassing
    // fn_create_tournament, so its 10% was CHARGED rather than merely quoted.
    expect(scheduled).not.toMatch(/buyInFor\(buyIn\)\s*:/);
    expect(scheduled).toMatch(/const rakeRate = rakeRateFor\(/);
    expect(scheduled).toMatch(/buyInFor\(buyIn,\s*rakeRate\)/);
  });

  it('the field size is resolved BEFORE the price that depends on it', () => {
    expect(scheduled.indexOf('const maxPlayers =')).toBeLessThan(
      scheduled.indexOf('const rakeRate = rakeRateFor(')
    );
  });

  it('the legacy tournament-page form is gone, not merely repriced', () => {
    // One of the six writers was LegacyCreateTournamentModal, defined inside
    // TournamentPage.tsx and rendered by nothing while still holding a
    // reachable createTournament call at the 10% default. It was deleted on
    // 2026-08-27 rather than corrected: dead code on a money path is a hazard,
    // not a spare part, and a quote path that does not exist cannot misquote.
    const page = stripComments(read('src/pages/TournamentPage.tsx'));
    expect(page).not.toMatch(/splitBuyIn\(/);
    expect(page).not.toMatch(/LegacyCreateTournamentModal/);
  });

  it('the client quote paths ask the same question', () => {
    for (const path of [
      'src/components/club/CreateTournamentModal.tsx',
      'src/lib/tournamentFromTableConfig.ts',
    ]) {
      const src = stripComments(read(path));
      expect(src, path).toMatch(/rakeRateFor\(/);
      // EVERY call site passes a rate. A bare splitBuyIn(total) takes the 10%
      // default, which is the misquote this fix exists to end -- and one
      // forgotten call site is all it takes to bring it back.
      const calls = [...src.matchAll(/splitBuyIn\(/g)];
      expect(calls.length, `${path} has no splitBuyIn calls left to check`).toBeGreaterThan(0);
      for (const m of calls) {
        const tail = src.slice(m.index ?? 0, (m.index ?? 0) + 140);
        expect(tail, `${path}: splitBuyIn without a rate -> ${tail.split('\n')[0]}`).toMatch(
          /[rR]akeRate/
        );
      }
    }
  });
});

describe('4. the applying payout sweep stays retired after the root fix', () => {
  it('the daemon has no applying tournament-payout path left', () => {
    expect(settler).not.toContain('fn_tournament_payout_sweep');
    expect(settler).not.toContain('runTournamentPayoutSweep');
    expect(settler).not.toContain('payoutSweepPass');
    expect(settler).not.toContain('PAYOUT_SWEEP_');
  });

  it('keeps the read-only conservation detectors', () => {
    expect(settler).toContain('runTournamentSentinel');
    expect(settler).toContain('runTournamentChipConservation');
  });

  it('the cutover removes the applying cron and its expected-roster entry', () => {
    expect(atomicSettlementMigration).toMatch(
      /cron\.unschedule\(j\.jobid\)[\s\S]*j\.jobname = 'ca-payout-sweep-hourly'/
    );
    expect(atomicSettlementMigration).toMatch(
      /DELETE FROM public\.ca_expected_cron_jobs[\s\S]*ca-payout-sweep-hourly/
    );
  });
});
