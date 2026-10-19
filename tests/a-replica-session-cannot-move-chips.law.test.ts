/**
 * ===========================================================================
 *  A REPLICA SESSION CANNOT MOVE CHIPS (2026-10-15)
 * ===========================================================================
 *
 * Supply snapshot 942 (2026-10-06 16:05 UTC) read -14,081.45 unexplained. The
 * chips were 43 cash seats vacated at 15:33:04-15:33:09 by a psql session that
 * had set session_replication_role = replica. Every money guard on those
 * tables (ledger tally, commit-time ledger invariant, seat exit log, inventory
 * observer, autoledger) is an ordinary 'O' trigger, and an 'O' trigger does
 * not fire in replica mode, so nothing wrote a cashout or refused the write.
 *
 * 20261015105156 puts one statement-level guard on every chip store and sets
 * it ENABLE ALWAYS, so on a protected cluster a replica-mode write is refused
 * before a row moves. These pins keep the guard total and keep it ALWAYS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const FIX_VERSION = '20261015105156';
const FIX = '20261015105156_a_replica_session_cannot_move_chips.sql';
const read = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

const GUARDED = [
  'agents',
  'bbj_pools',
  'chip_escrow',
  'chip_ledger',
  'club_members',
  'club_opening_setups',
  'club_wallets',
  'clubs',
  'hand_atomic_commits',
  'spin_bonus_pools',
  'table_pending_addons',
  'table_seats',
  'tournament_escrow',
  'tournament_players',
  'tournament_tickets',
  'tournaments',
  'union_wallets',
  'unions',
];

describe('a replica session cannot move chips', () => {
  const sql = code(read(FIX));

  it('guards every chip store, for writes and truncates, statement-level', () => {
    for (const t of GUARDED) expect(sql).toContain(`'${t}'`);
    expect(sql).toMatch(
      /CREATE TRIGGER aaa_ca_refuse_replica_money_write BEFORE INSERT OR UPDATE OR DELETE ON public\.%I FOR EACH STATEMENT/
    );
    expect(sql).toMatch(
      /CREATE TRIGGER aaa_ca_refuse_replica_money_truncate BEFORE TRUNCATE ON public\.%I FOR EACH STATEMENT/
    );
  });

  it('sets both guards ENABLE ALWAYS, because an ordinary trigger is what replica mode skips', () => {
    expect(sql).toContain('ENABLE ALWAYS TRIGGER aaa_ca_refuse_replica_money_write');
    expect(sql).toContain('ENABLE ALWAYS TRIGGER aaa_ca_refuse_replica_money_truncate');
    expect(read(FIX)).toMatch(/^-- @live-proof: .*tgenabled = 'A'\) = 36$/m);
  });

  it('refuses only replica mode, only on a protected cluster, and never moves a row', () => {
    expect(sql).toMatch(
      /current_setting\('session_replication_role'\) <> 'replica' THEN\s+RETURN NULL;\s+END IF;\s+IF public\.fn_ca_is_protected_cluster\(\) THEN\s+RAISE EXCEPTION/
    );
    expect(sql).toMatch(/cluster_name', true\) = 'main'/);
    expect(sql).toContain("'7581440907192989109'");
    expect(sql).toContain("USING ERRCODE = '42501'");
    expect(sql).toMatch(/UPDATE public\.table_seats SET stack = stack WHERE false;/);
    expect(sql).toContain('REPLICA_MONEY_GUARD_DID_NOT_REFUSE');
    expect(sql).not.toMatch(
      /fn_ca_post_correction|INSERT INTO public\.chip_ledger|UPDATE public\.club_members/i
    );
  });

  it('acknowledges snapshot 942 in writing, from an asserted unchanged preimage', () => {
    expect(sql).toMatch(/WHERE id = 942 AND round\(unexplained, 2\) = -14081\.45/);
    expect(sql).toMatch(
      /INSERT INTO public\.ca_supply_breach_ack \(snapshot_id, acknowledged_by, reason\)\s+VALUES \(\s+942,/
    );
    expect(sql.trim()).toMatch(/COMMIT;$/);
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
  });

  it('no later migration disables, drops or downgrades the guard', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f) && f.slice(0, 14) > FIX_VERSION)
      .sort();
    const weakening =
      /(?:ENABLE\s+(?:REPLICA\s+)?|DISABLE\s+)TRIGGER\s+(?:aaa_ca_refuse_replica_money_(?:write|truncate)|ALL|USER)\b[^;]*;|DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?aaa_ca_refuse_replica_money|DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.fn_ca_(?:refuse_replica_money_write|is_protected_cluster)|CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_ca_(?:refuse_replica_money_write|is_protected_cluster)/gi;
    const offenders = later.flatMap((f) =>
      [...code(read(f)).matchAll(weakening)]
        .map((m) => m[0])
        .filter((s) => !/ENABLE\s+ALWAYS/i.test(s))
        .filter(
          (s) =>
            !/TRIGGER\s+(?:ALL|USER)\b/i.test(s) ||
            GUARDED.some((t) => new RegExp(`\\b${t}\\b`).test(code(read(f))))
        )
        .map((s) => `${f}: ${s.trim()}`)
    );
    expect(offenders).toEqual([]);
  });
});
