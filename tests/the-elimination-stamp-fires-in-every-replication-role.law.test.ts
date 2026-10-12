/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ELIMINATION STAMP FIRES IN EVERY REPLICATION ROLE (2026-10-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * elimination_sequence is database-owned: zz_stamp_tournament_elimination_sequence
 * stamps the next value when a roster row enters 'eliminated' and refuses any
 * hand-written one. It was an ordinary ENABLED trigger, and an ordinary trigger
 * does not fire while session_replication_role = replica.
 *
 * At 15:33:04 UTC on 2026-10-06 a psql force drain of the retired fleet cohort
 * ran in exactly such a session:
 *
 *     UPDATE public.tournament_players tp
 *        SET status = 'eliminated', eliminated_at = clock_timestamp() ...
 *
 * and left live players eliminated with a NULL sequence in four running Spins
 * and five registering events. With one unsequenced bust the last bust cannot
 * be named, so the terminal authority refused every finish (P0404) for 22
 * hours, and on 62a15104 the refusal starved the PostgREST pool hourly.
 *
 * 20261007132903 sets the stamp ENABLE ALWAYS, so a trigger-bypassing session
 * still cannot eliminate a player without the next sequence. These pins keep it
 * that way, and keep the four-Spin settlement (20261007132839) a seat
 * restoration that moves no money.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const FIX_VERSION = '20261007132903';
const FIX = '20261007132903_the_elimination_stamp_fires_in_every_replication_role.sql';
const SETTLE = '20261007132839_four_retired_spin_entries_return_to_their_chairs.sql';
const read = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('the elimination stamp is not bypassed by replica mode', () => {
  it('the fix enables the stamp ALWAYS, from an asserted unchanged preimage, in one short transaction', () => {
    const sql = code(read(FIX));
    expect(sql).toMatch(
      /ALTER TABLE public\.tournament_players\s+ENABLE ALWAYS TRIGGER zz_stamp_tournament_elimination_sequence;/
    );
    expect(sql).toContain("IS DISTINCT FROM 'O'");
    expect(sql).toContain("'1da72fa956566502be6d6c8d46ba6d2a'");
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
    expect(sql.trim()).toMatch(/COMMIT;$/);
    // The stamp's own body is not touched: only the catalogue flag changes.
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(read(FIX)).toMatch(
      /^-- @live-proof: .*tgname = 'zz_stamp_tournament_elimination_sequence'\) = 'A'$/m
    );
  });

  it('no later migration turns the stamp back into an ordinary, replica-only or disabled trigger', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f) && f.slice(0, 14) > FIX_VERSION)
      .sort();
    const weakening =
      /(?:ENABLE\s+(?:REPLICA\s+)?|DISABLE\s+)TRIGGER\s+(?:zz_stamp_tournament_elimination_sequence|ALL|USER)\b[^;]*;|DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?zz_stamp_tournament_elimination_sequence/gi;
    const offenders = later.flatMap((f) => {
      const sql = code(read(f));
      if (!/tournament_players|zz_stamp_tournament_elimination_sequence/.test(sql)) return [];
      return [...sql.matchAll(weakening)]
        .map((m) => m[0])
        .filter((s) => !/ENABLE\s+ALWAYS/i.test(s))
        .filter((s) => /zz_stamp|tournament_players/i.test(s) || /ALL|USER/i.test(s))
        .map((s) => `${f}: ${s.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the four retired Spin entries go back to their chairs and no money moves', () => {
  const sql = code(read(SETTLE));

  it('names exactly the four Spins and revives each through the platform seat owner', () => {
    for (const t of [
      '87f6d0ee-0e7b-4921-87f4-b481f43973b1',
      '9d4067ab-162d-4208-8595-8120c3d08873',
      'a19b10fe-4192-41ba-9b2a-7ef9ac70d23f',
      'a6ae23f9-81a4-4121-a942-1fec54923e66',
    ]) {
      expect(sql).toContain(`'${t}'`);
    }
    expect(sql).toContain('public.fn_ca_lock_tournament_seat_acquisition(c.tid, c.tbl, c.r_user)');
    expect(sql).toContain(
      'public.fn_assign_tournament_player_seat_atomic(c.tid, c.r_user, c.tbl, c.r_seat_no)'
    );
    // The seat door's locks come before the first changed row.
    expect(sql.indexOf('fn_ca_lock_tournament_seat_acquisition')).toBeLessThan(
      sql.indexOf('UPDATE public.tournament_players')
    );
  });

  it('asserts the witness: never dealt, unsequenced, paid stack on the closed chair, bust kept at third', () => {
    expect(sql).toContain('FOUR_SPINS_RETIRED_ENTRY_WAS_DEALT');
    expect(sql).toContain('tp.elimination_sequence IS NULL');
    expect(sql).toContain('s.stack = c.start_stack');
    expect(sql).toContain('tp.elimination_sequence = c.bust_seq AND tp.position = 3');
    expect(sql).toContain('felt <> 3 * c.start_stack');
    expect(sql).toContain('fn_platform_frozen()');
  });

  it('writes no wallet, ledger, journal, prize, payout or Spin receipt row', () => {
    const writes = [...sql.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_.]+)/gi)].map(
      (m) => m[2].toLowerCase()
    );
    expect(writes).toEqual(['public.tournament_players']);
    expect(sql).not.toMatch(
      /fn_credit|fn_add_chips|fn_transfer|chip_ledger\s*\(|wallet_transactions\s*\(/i
    );
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });
});
