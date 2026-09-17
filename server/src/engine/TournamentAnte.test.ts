/**
 * A TOURNAMENT ANTE IS NOT SUBJECT TO THE CASH TOGGLE.
 *
 * FIX-219 gated the ante on `tables.ante_enabled`, which is correct for cash:
 * CreateTableModal writes that toggle (`ante_enabled: parseFloat(anteAmount) >
 * 0`) and the lobby gates its ante badge on it.
 *
 * It is wrong for tournaments, where the ante comes from the BLIND STRUCTURE.
 * `refreshBlindsFromDb` updates `this.tableInfo.ante` on every level change and
 * cannot set a toggle it does not own.
 *
 * MEASURED IN PRODUCTION 2026-08-27: `ante_enabled` was FALSE on ALL 93,416
 * table rows, so the gate yielded `undefined` every single time and
 * HandController's `if (this.config.ante)` never fired. NO ANTE HAD EVER BEEN
 * POSTED, on any table, anywhere. 10,085 tournaments carry non-zero antes in
 * their blind structure and 43 were live at that moment -- each advertising
 * "Level N: x/y ante z" in its blinds tab and collecting nothing.
 *
 * HOW THIS HID: the obvious check, "do ante actions appear in
 * hand_history.actions", returns zero -- but so does a search for BLINDS,
 * because `actions` records only voluntary actions and forced posts never
 * appear there. The absence proved nothing, and a chi-square-style pot
 * comparison was also useless because tournament blinds escalate, so joining a
 * table's CURRENT blind level to a historical hand compares two different
 * games. The gate had to be read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, 'ServerTableEngineDealing.ts'), 'utf8');
/* Comments quote the old expression, deliberately. Strip them or the tombstone
   is mistaken for the thing it replaced. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the ante gate', () => {
  it('no longer suppresses every ante on every table', () => {
    /* The exact expression that made `config.ante` undefined 100% of the time,
       because ante_enabled is false on all 93,416 rows. */
    expect(
      CODE,
      'the unconditional cash toggle is back - no tournament will post an ante'
    ).not.toMatch(
      /ante:\s*\(this\.tableInfo\.ante_enabled \?\? true\)\s*\?\s*this\.tableInfo\.ante\s*:\s*undefined/
    );
  });

  it('lets a tournament take the ante its blind level specifies', () => {
    expect(CODE).toMatch(/ante:\s*this\.tableInfo\.tournament_id/);
  });

  it('KEEPS the toggle for cash tables', () => {
    /* FIX-219 / Bible V8 4.3 is still correct for cash. This fix narrows it to
       cash, it does not delete it. */
    expect(CODE).toMatch(/ante_enabled \?\? true/);
  });

  it('still reads the ante that the level refresh writes', () => {
    // Refresh writes through the captured original table, so a delayed read
    // cannot retarget a replacement. Pin that reference through to the writer;
    // BlindRefreshContinuation exercises the real refresh and stale refusal.
    const refresh = CODE.slice(
      CODE.indexOf('  protected refreshBlinds()'),
      CODE.indexOf('  protected async dealHand(')
    );
    expect(refresh).toContain('const originalTable = this.tableInfo;');
    expect(refresh).toContain('this.tableInfo === originalTable');
    expect(refresh).toContain('this.refreshBlindsOwned(current, originalTable)');
    expect(refresh).toContain('table: NonNullable<typeof this.tableInfo>');
    expect(refresh).toContain('table.ante = data.ante;');
    expect(CODE).toMatch(/ante:\s*this\.tableInfo\.tournament_id\s*\?\s*this\.tableInfo\.ante/);
  });
});

describe('the shape of the fix', () => {
  it('branches on tournament_id, not on a re-derived guess', () => {
    /* Deciding "is this a tournament" any other way -- by table name, by
       whether a blind structure exists, by player count -- would drift from
       what the rest of the engine means by it. */
    const gate = CODE.slice(
      CODE.indexOf('ante: this.tableInfo.tournament_id'),
      CODE.indexOf('bigBlindAnte')
    );
    /* `\.name\b` and not `name`: the first version of this assertion used the
       bare word and failed on correct code, because "tournament" CONTAINS
       "name" (tour-name-nt). That is the same substring trap this whole audit
       keeps finding in production code, so it is worth leaving the reason
       written down rather than just the fix. */
    expect(gate).not.toMatch(/\.name\b|blind_structure|max_players/);
  });

  it('does not touch bigBlindAnte, which is a separate feature', () => {
    expect(CODE).toMatch(/bigBlindAnte:\s*this\.tableInfo\.big_blind_ante_enabled \?\? false/);
  });
});
