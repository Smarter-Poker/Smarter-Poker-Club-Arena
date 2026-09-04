/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FREEROLLS ARE FREE BUY (Dan, 2026-09-02, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "FREE ROLLS MUST ALWAYS BE SET AS 'FREE BUY'. ITS FREE TO
 * ENTER, $0 BUY IN, BUT REBUYS AND ADD ON'S COST $1. MAKE SURE THAT IS BAKED IN
 * HOW EVER ITS NEEDED."
 *
 * Measured 2026-09-02 18:22 UTC: of 262 freerolls created in the previous 14
 * days, ZERO followed the rule end to end. 183 had no rebuy and no add-on at
 * all; 58 charged 1.00 for the rebuy and gave the add-on away at 0.00, because
 * tournament_schedules spelled the key `addonCost` and the spawner read
 * `addOnCost`.
 *
 * The rule now lives in three places that must agree, and this law pins each:
 *
 *   1. THE DATABASE BACKSTOP - migration 20260902183602: a BEFORE INSERT OR
 *      UPDATE trigger on tournaments that NORMALISES a freeroll to 1.00
 *      rebuys and 1.00 add-ons, both on, and never RAISES (a refused
 *      scheduler insert would stop freerolls being created at all).
 *   2. THE ENGINE - server/src/config/buyIn.ts freeBuyColumns(), spread LAST
 *      over every freeroll insert in TournamentRecurringService and
 *      ScheduledTournamentService, so the trigger is the backstop, not the
 *      mechanism.
 *   3. THE CLIENT - src/utils/freeBuy.ts freeBuyConfig(), applied in
 *      TournamentService.buildRpcConfig (every creation surface funnels
 *      through it) and tournamentFromTableConfig, with the table-config form
 *      locking the controls and saying why.
 *
 * Every pin below was negative-controlled: the guarded text was mutated, the
 * pin went red, the text was restored.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  FREE_BUY_ADDON_COST,
  FREE_BUY_ADDON_LEVELS,
  FREE_BUY_HELPER,
  FREE_BUY_LABEL,
  FREE_BUY_REBUY_COST,
  FREE_BUY_REBUY_LEVELS,
  freeBuyColumns as clientFreeBuyColumns,
  freeBuyConfig,
  isFreeBuyEvent as clientIsFreeBuyEvent,
} from '../../src/utils/freeBuy';
import {
  FREE_BUY_ADDON_COST as SERVER_ADDON_COST,
  FREE_BUY_ADDON_LEVELS as SERVER_ADDON_LEVELS,
  FREE_BUY_REBUY_COST as SERVER_REBUY_COST,
  FREE_BUY_REBUY_LEVELS as SERVER_REBUY_LEVELS,
  freeBuyColumns as serverFreeBuyColumns,
  isFreeBuyEvent as serverIsFreeBuyEvent,
} from '../../server/src/config/buyIn';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIGRATION = read('supabase/migrations/20260902183602_freerolls_are_free_buy.sql');
/* THE PIN MOVED HERE (Dan 2026-09-04). The pricing half of the 2026-09-02 law
   is superseded by this migration: $1 is still forced on every freeroll, but a
   SCHEDULED Free Buy that set its own price keeps it, because the $500 tier
   charges $2. Both laws survive - see the migration header. CLAUDE.md 10.8
   requires the pin to move to the new mechanism in the same commit, so the
   tier-aware assertions below read this file, not the older one. */
const PRICING = read(
  'supabase/migrations/20260904032000_free_buy_tiers_may_set_their_own_price.sql'
);
const RECURRING = read('server/src/services/TournamentRecurringService.ts');
const SCHEDULED = read('server/src/services/ScheduledTournamentService.ts');
const SERVICE = read('src/services/TournamentService.ts');
const FROM_FORM = read('src/lib/tournamentFromTableConfig.ts');
const FORM = read('src/pages/TableConfigPage.tsx');
const LOBBY = read('src/components/lobby/lobbyEntries.ts');
const BUYIN = read('src/utils/buyIn.ts');

/** The body of one CREATE OR REPLACE FUNCTION ... $$ ... $$ block. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$;', open + 2);
  return sql.slice(open + 2, close);
}

describe('1. the database backstop normalises, and never raises', () => {
  const body = functionBody(MIGRATION, 'fn_freerolls_are_free_buy');

  it('forces rebuys and add-ons ON at 1.00 each and a 0 fee', () => {
    expect(body).toMatch(/NEW\.is_rebuy\s*:=\s*true;/);
    expect(body).toMatch(/NEW\.add_on_available\s*:=\s*true;/);
    expect(body).toMatch(/NEW\.rebuy_cost\s*:=\s*1\.00;/);
    expect(body).toMatch(/NEW\.addon_cost\s*:=\s*1\.00;/);
    expect(body).toMatch(/NEW\.buy_in_fee\s*:=\s*0;/);
  });

  it('fills chips from the starting stack and the windows from the column defaults', () => {
    expect(body).toMatch(/NEW\.rebuy_chips\s*:=\s*v_stack;/);
    expect(body).toMatch(/NEW\.addon_chips\s*:=\s*v_stack;/);
    expect(body).toMatch(/NEW\.rebuy_levels\s*:=\s*4;/);
    expect(body).toMatch(/NEW\.addon_levels\s*:=\s*1;/);
    // process_tournament_rebuy reads a NOT NULL 0 as "Rebuy limit reached".
    expect(body).toMatch(/NEW\.max_rebuys\s*:=\s*NULL;/);
  });

  it('contains no RAISE EXCEPTION - a refused insert would stop freerolls being created', () => {
    expect(body).not.toMatch(/RAISE\s+EXCEPTION/i);
    // The log fallback is a WARNING, which is allowed.
    expect(body).toMatch(/RAISE\s+WARNING/i);
  });

  it('never rewrites a live or finished event', () => {
    expect(body).toMatch(
      /TG_OP\s*=\s*'UPDATE'\s*AND\s*upper\(COALESCE\(NEW\.status,\s*''\)\)\s*NOT IN\s*\('ANNOUNCED',\s*'REGISTERING'\)/
    );
  });

  it('is wired as a BEFORE INSERT OR UPDATE trigger on tournaments', () => {
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER zz_freerolls_are_free_buy\s+BEFORE INSERT OR UPDATE OF[\s\S]*?ON public\.tournaments/
    );
    expect(MIGRATION).toMatch(/EXECUTE FUNCTION public\.fn_freerolls_are_free_buy\(\)/);
  });

  it('logs every normalisation to ca_freeroll_free_buy_log', () => {
    expect(body).toMatch(/INSERT INTO public\.ca_freeroll_free_buy_log/);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_freeroll_free_buy_log/);
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON public\.ca_freeroll_free_buy_log FROM PUBLIC, anon, authenticated/
    );
  });

  it('the predicate excludes Spins and SNGs and nothing else', () => {
    const pred = functionBody(MIGRATION, 'fn_is_free_buy_event');
    expect(pred).toMatch(/COALESCE\(p_buy_in_amount, 0\) = 0/);
    expect(pred).toMatch(/COALESCE\(p_buy_in_fee, 0\) = 0/);
    expect(pred).toMatch(/= 'MTT'/);
    expect(pred).toMatch(/NOT IN \('spin', 'sng'\)/);
  });

  it('backfills only NOT-STARTED freerolls and asserts zero violators after', () => {
    const backfill = MIGRATION.slice(MIGRATION.indexOf('UPDATE public.tournaments t'));
    expect(backfill).toMatch(/IN \('ANNOUNCED', 'REGISTERING'\)/);
    expect(backfill).not.toMatch(/'RUNNING'\s*\)/);
    expect(MIGRATION).toMatch(/still violate the Free Buy rule after backfill/);
    expect(MIGRATION).toMatch(/backfill touched an event that had already started/);
  });
});

describe('2. the engine passes the rule explicitly', () => {
  it('the recurring service spreads freeBuyColumns over BOTH MTT inserts, last', () => {
    expect(RECURRING).toMatch(/import \{[^}]*freeBuyColumns[^}]*\} from '\.\.\/config\/buyIn\.js'/);
    const spreads = RECURRING.match(/\.\.\.freeBuyColumns\(\{/g) ?? [];
    expect(spreads.length, 'XMTT insert + MTT insert').toBe(2);
    // Spread comes AFTER the template's own addon_levels key in each insert.
    for (const m of RECURRING.matchAll(
      /addon_levels: \(config as \{ addOn\?: boolean \}\)\.addOn \? 1 : null,\s*\n([\s\S]{0,400})/g
    )) {
      expect(m[1]).toMatch(/\.\.\.freeBuyColumns\(\{/);
    }
  });

  it('the scheduled service spreads freeBuyColumns over its insert row, last', () => {
    expect(SCHEDULED).toMatch(/import \{[^}]*freeBuyColumns[^}]*\} from '\.\.\/config\/buyIn\.js'/);
    const rowStart = SCHEDULED.indexOf('const row: Record<string, unknown> = {');
    const rowEnd = SCHEDULED.indexOf('\n    };\n', rowStart);
    const row = SCHEDULED.slice(rowStart, rowEnd);
    expect(row).toMatch(/\.\.\.freeBuyColumns\(\{/);
    expect(row.indexOf('...freeBuyColumns({')).toBeGreaterThan(row.indexOf('addon_levels:'));
    expect(row.indexOf('...freeBuyColumns({')).toBeGreaterThan(row.indexOf('max_rebuys:'));
  });

  it('the scheduled service reads BOTH spellings of the add-on keys (the 0.00 add-on bug)', () => {
    expect(SCHEDULED).toMatch(/cfg\.addOnCost \?\? cfg\.addonCost/);
    expect(SCHEDULED).toMatch(/cfg\.addOnChips \?\? cfg\.addonChips/);
    expect(SCHEDULED).toMatch(/cfg\.addOnLevels \?\? cfg\.addonLevels/);
  });

  it('server freeBuyColumns produces the rule for a freeroll and nothing for a paid event', () => {
    const free = serverFreeBuyColumns({
      buyIn: 0,
      tournamentType: 'MTT',
      variant: 'freezeout',
      startingStack: 5000,
    });
    expect(free).toMatchObject({
      buy_in_fee: 0,
      is_rebuy: true,
      is_reentry: true,
      add_on_available: true,
      rebuy_cost: 1,
      addon_cost: 1,
      rebuy_chips: 5000,
      addon_chips: 5000,
      rebuy_levels: 4,
      addon_levels: 1,
      max_rebuys: null,
    });
    expect(
      serverFreeBuyColumns({
        buyIn: 10,
        tournamentType: 'MTT',
        variant: 'freezeout',
        startingStack: 5000,
      })
    ).toEqual({});
    expect(
      serverFreeBuyColumns({
        buyIn: 0,
        tournamentType: 'SPIN',
        variant: 'spin',
        startingStack: 500,
      })
    ).toEqual({});
    expect(
      serverFreeBuyColumns({ buyIn: 0, tournamentType: 'SNG', variant: 'sng', startingStack: 1500 })
    ).toEqual({});
    // A positive cap passes through; 0 is cleared (the RPC reads 0 as "limit reached").
    expect(serverFreeBuyColumns({ buyIn: 0, startingStack: 5000, maxRebuys: 2 }).max_rebuys).toBe(
      2
    );
    expect(
      serverFreeBuyColumns({ buyIn: 0, startingStack: 5000, maxRebuys: 0 }).max_rebuys
    ).toBeNull();
  });
});

describe('3. the client applies the rule and the form says so', () => {
  it('buildRpcConfig spreads freeBuyConfig last, so every creation surface carries it', () => {
    expect(SERVICE).toMatch(/import \{[^}]*freeBuyConfig[^}]*\} from '\.\.\/utils\/freeBuy'/);
    const start = SERVICE.indexOf('buildRpcConfig(config: TournamentConfig)');
    const body = SERVICE.slice(start, SERVICE.indexOf('// ── Parity keys', start));
    expect(body).toMatch(/\.\.\.freeBuyConfig\(\{/);
    expect(body.indexOf('...freeBuyConfig({')).toBeGreaterThan(body.indexOf('addOnLevels:'));
  });

  it('buildRpcConfig never sends a 0 rebuy cap for a freeroll', () => {
    expect(SERVICE).toMatch(
      /const freeBuy = isFreeBuyEvent\(\{ buyIn: config\.buyIn, type: config\.type \}\)/
    );
    expect(SERVICE).toMatch(
      /config\.maxRebuys !== undefined && !\(freeBuy && !\(config\.maxRebuys > 0\)\)/
    );
  });

  it('tournamentFromTableConfig spreads freeBuyConfig last', () => {
    expect(FROM_FORM).toMatch(/import \{ freeBuyConfig \} from '\.\.\/utils\/freeBuy'/);
    expect(FROM_FORM).toMatch(/\.\.\.freeBuyConfig\(\{/);
    expect(FROM_FORM.indexOf('...freeBuyConfig({')).toBeGreaterThan(
      FROM_FORM.indexOf('addOnLevels: 1,')
    );
  });

  it('the table-config form shows the Free Buy badge and locks rebuy and add-on at 1 chip', () => {
    expect(FORM).toMatch(/data-testid="free-buy-badge"/);
    expect(FORM).toMatch(/\{FREE_BUY_LABEL\}/);
    expect(FORM).toMatch(/data-testid="free-buy-lock"/);
    expect(FORM).toMatch(/label="Rebuy Cost"\s+value=\{FREE_BUY_REBUY_COST\}[\s\S]{0,80}disabled/);
    expect(FORM).toMatch(/label="Add-On Cost"\s+value=\{FREE_BUY_ADDON_COST\}[\s\S]{0,80}disabled/);
    expect(FORM).toMatch(/\{FREE_BUY_HELPER\}/);
  });

  it('the lobby and every buy-in cell read "Free Buy" for a freeroll', () => {
    expect(FREE_BUY_LABEL).toBe('Free Buy');
    expect(LOBBY).toMatch(/label: FREE_BUY_LABEL, tip: FREE_BUY_HELPER/);
    expect(LOBBY).toMatch(/buyInLabel: total <= 0 \? FREE_BUY_LABEL/);
    expect(BUYIN).toMatch(/if \(total <= 0\) return FREE_BUY_LABEL;/);
    expect(BUYIN).toMatch(/total <= 0 \? FREE_BUY_LABEL : money\(total\)/);
  });

  it('the copy is Title Case Every Word with no em dash', () => {
    for (const s of [FREE_BUY_LABEL, FREE_BUY_HELPER]) {
      expect(s).not.toContain('—');
      for (const word of s.split(/\s+/)) {
        expect(word[0], `"${word}" in "${s}"`).toMatch(/[A-Z0-9]/);
      }
    }
  });

  it('client freeBuyConfig produces the rule for a freeroll and nothing for a paid event', () => {
    expect(freeBuyConfig({ buyIn: 0, type: 'mtt', startingStack: 5000 })).toEqual({
      isRebuy: true,
      isReentry: true,
      addOnAvailable: true,
      rebuyCost: 1,
      addOnCost: 1,
      rebuyChips: 5000,
      addOnChips: 5000,
      rebuyLevels: 4,
      addOnLevels: 1,
    });
    expect(
      freeBuyConfig({ buyIn: 0, type: 'mtt', startingStack: 5000, maxRebuys: 3 }).maxRebuys
    ).toBe(3);
    expect(
      freeBuyConfig({ buyIn: 0, type: 'mtt', startingStack: 5000, maxRebuys: 0 }).maxRebuys
    ).toBeUndefined();
    expect(freeBuyConfig({ buyIn: 5, type: 'mtt', startingStack: 5000 })).toEqual({});
    expect(freeBuyConfig({ buyIn: 0, type: 'spin', startingStack: 500 })).toEqual({});
    expect(freeBuyConfig({ buyIn: 0, type: 'sng', startingStack: 1500 })).toEqual({});
    expect(clientFreeBuyColumns({ buyIn: 0, type: 'bounty', startingStack: 3000 })).toMatchObject({
      rebuy_cost: 1,
      addon_cost: 1,
      is_rebuy: true,
      add_on_available: true,
      max_rebuys: null,
    });
  });
});

describe('the three copies of the rule agree', () => {
  it('constants match between client and engine', () => {
    expect(FREE_BUY_REBUY_COST).toBe(SERVER_REBUY_COST);
    expect(FREE_BUY_ADDON_COST).toBe(SERVER_ADDON_COST);
    expect(FREE_BUY_REBUY_LEVELS).toBe(SERVER_REBUY_LEVELS);
    expect(FREE_BUY_ADDON_LEVELS).toBe(SERVER_ADDON_LEVELS);
    expect(FREE_BUY_REBUY_COST).toBe(1);
    expect(FREE_BUY_ADDON_COST).toBe(1);
  });

  it('the predicate agrees across client, engine and migration on every format', () => {
    const cases: Array<[number, string, string, boolean]> = [
      [0, 'MTT', 'freezeout', true],
      [0, 'MTT', 'bounty', true],
      [0, 'MTT', 'progressive_bounty', true],
      [0, 'MTT', 'satellite', true],
      [0, 'SPIN', 'spin', false],
      [0, 'SNG', 'sng', false],
      [1, 'MTT', 'freezeout', false],
      [25, 'MTT', 'bounty', false],
    ];
    for (const [buyIn, tournamentType, variant, expected] of cases) {
      expect(
        serverIsFreeBuyEvent({ buyIn, tournamentType, variant }),
        `server ${buyIn}/${variant}`
      ).toBe(expected);
      expect(
        clientIsFreeBuyEvent({ buyIn, tournamentType, type: variant }),
        `client ${buyIn}/${variant}`
      ).toBe(expected);
    }
  });
});

describe('7. a scheduled Free Buy prices itself, and nothing else does', () => {
  const body = functionBody(PRICING, 'fn_freerolls_are_free_buy');

  it('still forces 1.00 on an ordinary freeroll - the 2026-09-02 law survives', () => {
    expect(body).toMatch(/NEW\.rebuy_cost\s*:=\s*1\.00;/);
    expect(body).toMatch(/NEW\.addon_cost\s*:=\s*1\.00;/);
    expect(body).toMatch(/NEW\.buy_in_fee\s*:=\s*0;/);
    expect(body).toMatch(/NEW\.is_rebuy\s*:=\s*true;/);
    expect(body).toMatch(/NEW\.add_on_available\s*:=\s*true;/);
  });

  it('gates BOTH price overwrites on the event not having priced itself', () => {
    expect(body).toMatch(
      /v_priced\s*:=\s*COALESCE\(NEW\.free_buy,\s*false\)\s*AND\s*COALESCE\(NEW\.rebuy_cost,\s*0\)\s*>\s*0;/
    );
    expect(body).toMatch(/IF NOT v_priced AND NEW\.rebuy_cost IS DISTINCT FROM 1\.00 THEN/);
    expect(body).toMatch(/IF NOT v_priced AND NEW\.addon_cost IS DISTINCT FROM 1\.00 THEN/);
  });

  it('treats a missing price as missing, not as a decision', () => {
    // COALESCE(NEW.rebuy_cost, 0) > 0 - a NULL or 0 falls through to the default.
    expect(body).toMatch(/COALESCE\(NEW\.rebuy_cost,\s*0\)\s*>\s*0/);
  });

  it('never leaves a priced event with a 1.00 add-on under a 2.00 rebuy', () => {
    expect(body).toMatch(/IF v_priced AND COALESCE\(NEW\.addon_cost,\s*0\)\s*<=\s*0 THEN/);
    expect(body).toMatch(/NEW\.addon_cost\s*:=\s*NEW\.rebuy_cost;/);
  });

  it('leaves the chip and level defaults exactly as they were', () => {
    expect(body).toMatch(/NEW\.rebuy_chips\s*:=\s*v_stack;/);
    expect(body).toMatch(/NEW\.addon_chips\s*:=\s*v_stack;/);
    expect(body).toMatch(/NEW\.rebuy_levels\s*:=\s*4;/);
    expect(body).toMatch(/NEW\.addon_levels\s*:=\s*1;/);
    expect(body).toMatch(/NEW\.max_rebuys\s*:=\s*NULL;/);
  });

  it('still refuses to raise, and still never rewrites a live event', () => {
    expect(body).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(body).toMatch(/RAISE\s+WARNING/i);
    expect(body).toMatch(/TG_OP\s*=\s*'UPDATE'/);
  });
});
