/**
 * THE VPIP READERS SHARE THE EVICTION'S WINDOW (2026-10-24).
 *
 * The maintain-VPIP floor has one enforcer (fn_nit_check, via
 * fn_nit_evictions) and two readers: fn_nit_status, which every horse steers
 * by, and fn_cash_vpip_status, the player's own tracker on the felt. Each used
 * to carry its own copy of the sample window. When 20261024213131 turned the
 * PLO5/PLO6 Classic floor on mid-sitting and started the window at the game's
 * vpip_floor_since, only the enforcer was told: the readers kept counting
 * hands from before the floor existed (850 against the enforcer's 310 for one
 * live seat), so horses chased a floor they already met and a player's
 * tracker could say "below the floor" while the rule said otherwise.
 *
 * The window now lives in ONE function, fn_nit_sitting_since, and this pins
 * that all three call it and none carries a copy again. Same rule for every
 * player, horses included (CLAUDE.md 10.5).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const migrations = path.resolve(__dirname, '../supabase/migrations');
const FILE = readdirSync(migrations).find((f) =>
  f.endsWith('_vpip_readers_judge_the_same_window_as_the_eviction.sql')
)!;
const SQL = readFileSync(path.join(migrations, FILE), 'utf8');

/** The body of one CREATE OR REPLACE in this migration. */
function body(name: string): string {
  const m = SQL.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`)
  );
  if (!m) throw new Error(`${name} is not defined in ${FILE}`);
  return m[0];
}

describe('one window, three readers', () => {
  it('defines the window once: the sitting in the game, never before the floor existed', () => {
    const w = body('fn_nit_sitting_since');
    expect(w).toMatch(/FROM public\.cash_game_roster r/);
    expect(w).toMatch(/r\.left_at IS NULL/);
    expect(w).toMatch(/ruleset_snapshot->>'vpip_floor_since'/);
    expect(w).toMatch(/SELECT GREATEST\(/);
    expect(w).not.toMatch(/is_horse/);
  });

  it('both readers call it and carry no copy of the window', () => {
    for (const name of ['fn_nit_status', 'fn_cash_vpip_status']) {
      const b = body(name);
      expect(b).toMatch(/public\.fn_nit_sitting_since\(v_game,/);
      expect(b).not.toMatch(/cash_game_roster/);
      expect(b).not.toMatch(/vpip_floor_since/);
      expect(b).not.toMatch(/is_horse/);
    }
  });

  it('the enforcer is patched by anchor to call it, and refuses if a copy survives', () => {
    expect(SQL).toMatch(
      /v_since := public\.fn_nit_sitting_since\(v_game, p_user_id, p_since\);\$b\$\);/
    );
    expect(SQL).toMatch(/position\('cash_game_roster' in n\) > 0 THEN/);
    // Its career block is pinned verbatim elsewhere, so it is never re-declared here.
    expect(SQL).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_nit_check\(/);
  });

  it('proves on live tables that the reader and the eviction flag the same seats', () => {
    expect(SQL).toMatch(
      /FULL JOIN public\.fn_nit_evictions\(t\.id\) ev ON ev\.user_id = st\.user_id/
    );
    expect(SQL).toMatch(/where the VPIP reader and the eviction still disagree/);
  });

  it('is md5-guarded, keeps the helper off the public API, and is one transaction', () => {
    expect(SQL).toMatch(/9b00a65ac960a5918c9f2632164fa02a/);
    expect(SQL).toMatch(/836cbf38580d1ced2cf3e59f7e172e18/);
    expect(SQL).toMatch(/e791519877d80561dbfbfbbbd5060b91/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_nit_sitting_since\(uuid, uuid, timestamptz\) FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(/^BEGIN;/m);
    expect(SQL).toMatch(/^COMMIT;/m);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '1s'/);
  });
});
