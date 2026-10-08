/**
 * LIGHTNING PHASE 10 (SPECIFICATION PHASES 16 AND 17, THE DATABASE SIDE):
 * RESPONSIBLE GAMING / AUTO-REBUY INTEGRATION AND THE RNG / HIDDEN
 * INFORMATION REVIEW.
 *
 * A static reading of ONE migration, 20261008111425. The harness
 * scripts/dev/test-lightning-phase10-rg-rebuy.sh proves every claim against a
 * running catalogue and estate; this file proves what a catalogue cannot see:
 * the transaction shape, the signatures and grants the engine and client are
 * built against, that every change to an existing body is an asserted
 * substitution, that the stop door asks who is calling and the auto-rebuy
 * door buys only through the existing reload path, and that horses are never
 * singled out.
 *
 * LIGHTNING_P10_MIGRATION overrides the file under test, for mutation
 * testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261008111425_lightning_phase_10_responsible_gaming_stop_playing_auto_rebu.sql';
const MIGRATION =
  process.env.LIGHTNING_P10_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase10-rg-rebuy.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-08-lightning-phase-10-rg-rebuy.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase10-rg-rebuy.json')
);

/** The SQL with line comments removed. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/** The text of one CREATE OR REPLACE FUNCTION, header to its closing tag. */
function fn(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const end = SQL.indexOf('$fn$;', start);
  expect(end, name).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

/** One asserted substitution, by the signature it rewrites. */
function rewrite(oldSig: string): string {
  const start = SQL.indexOf(`SELECT pg_temp.lp10_rewrite(\n  '${oldSig}',`);
  expect(start, oldSig).toBeGreaterThan(0);
  return SQL.slice(start, SQL.indexOf(']);', start) + 3);
}

/** The two doors this file creates new. */
const DOORS = ['fn_lightning_stop_playing', 'fn_lightning_auto_rebuy'];
/** The five existing bodies it substitutes into. */
const REWRITTEN = [
  'public.fn_lightning_config(uuid)',
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  'public.fn_lightning_pool_enter(uuid,timestamp with time zone)',
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  'public.fn_lightning_reconnect_state(uuid)',
];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('alters only lightning_pool_session, creates no table and locks neither tables nor table_seats nor a wallet', () => {
    expect(
      CODE.match(/ALTER TABLE public\.\w+/g)?.every((m) => m.endsWith('lightning_pool_session'))
    ).toBe(true);
    expect(CODE).not.toMatch(/\bCREATE TABLE\b/);
    expect(CODE).not.toMatch(/\bLOCK TABLE\b/);
    expect(CODE).not.toMatch(/ALTER TABLE public\.(tables|table_seats|club_members|wallets)\b/);
  });
  it('the columns, the constraint and the index are guarded so the file re-applies', () => {
    expect(CODE).toMatch(/ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz,/);
    expect(CODE).toMatch(/ADD COLUMN IF NOT EXISTS auto_rebuys integer NOT NULL DEFAULT 0,/);
    expect(CODE).toMatch(/ADD COLUMN IF NOT EXISTS auto_rebuy_total numeric NOT NULL DEFAULT 0;/);
    expect(CODE).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_constraint[\s\S]+lightning_pool_session_auto_rebuy_counters_are_sane/
    );
    expect(CODE).toMatch(/CREATE INDEX IF NOT EXISTS lightning_pool_session_stop_requests/);
  });
  it('the counters refuse the negative', () => {
    expect(CODE).toMatch(/CHECK \(auto_rebuys >= 0 AND auto_rebuy_total >= 0\)/);
  });
});

describe('the stop door', () => {
  it('is the browser door: SECURITY DEFINER, auth.uid() scoped, granted to authenticated and service_role, never anon', () => {
    const f = fn('fn_lightning_stop_playing');
    expect(f).toContain('SECURITY DEFINER');
    expect(f).toContain('auth.uid()');
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_lightning_stop_playing\(uuid\) FROM PUBLIC, anon;/
    );
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_stop_playing\(uuid\) TO authenticated, service_role;/
    );
  });
  it('marks idempotently, exits only out of hand, and says what every exit says', () => {
    const f = fn('fn_lightning_stop_playing');
    expect(f).toContain('stop_requested_at = v_now');
    expect(f).toMatch(/IF s\.stop_requested_at IS NULL THEN/);
    expect(f).toContain('fn_lightning_player_in_hand');
    expect(f).toMatch(/r\.state IN \('pending', 'committed'\)/);
    expect(f).toContain("exit_reason = 'stop_playing'");
    expect(f).toContain("'pool_player_left'");
    expect(f).toContain("'stop_playing_requested'");
    expect(f).toContain("close_reason = 'pool_session_exited'");
    expect(f).toContain('fn_lightning_pool_stack');
    // The first mark alone speaks; a second tap writes nothing.
    expect(f).toMatch(/IF v_first THEN\s+INSERT INTO public\.cash_cluster_events/);
  });
});

describe('the auto-rebuy door', () => {
  it('is the engine door: no SECURITY DEFINER, service_role alone', () => {
    const f = fn('fn_lightning_auto_rebuy');
    expect(f).not.toContain('SECURITY DEFINER');
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_lightning_auto_rebuy\(uuid, uuid, timestamptz\) FROM PUBLIC, anon, authenticated;/
    );
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_auto_rebuy\(uuid, uuid, timestamptz\) TO service_role;/
    );
  });
  it('buys only through the existing reload door, with a deterministic purchase key, and never moves a chip itself', () => {
    const f = fn('fn_lightning_auto_rebuy');
    expect(f).toContain('public.atomic_table_rebuy(p_player_id, v_seat.table_id, v_amount, v_key)');
    expect(f).toMatch(/md5\('lightning_auto_rebuy:' \|\| s\.id::text/);
    expect(f).not.toMatch(/UPDATE public\.table_seats/);
    expect(f).not.toMatch(/club_members/);
    expect(f).not.toMatch(/wallet_transactions/);
    expect(f).not.toMatch(/INSERT INTO public\.table_pending_addons/);
  });
  it('verifies the session, the hand, responsible gaming, the pending addon, the count, the trigger and the caps, each with its own refusal', () => {
    const f = fn('fn_lightning_auto_rebuy');
    for (const reason of [
      'DISABLED',
      'NO_SESSION',
      'SESSION_NOT_ACTIVE',
      'STOP_REQUESTED',
      'DISCONNECTED',
      'IN_HAND',
      'RG_EXCLUDED',
      'ANCHOR_LEFT',
      'PENDING_ADDON',
      'MAX_COUNT',
      'NOT_TRIGGERED',
      'SESSION_CAP',
      'RELOAD_REFUSED',
    ])
      expect(f, reason).toContain(`'${reason}'`);
    expect(f).toContain('fn_rg_require_not_excluded');
    expect(f).toContain('fn_lightning_pool_stack');
    expect(f).toMatch(/a\.resolved_at IS NULL/);
    // The clock never runs ahead, as every service door's clock is guarded.
    expect(f).toContain('LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp())');
    // A wallet refusal is an answer, not an exception.
    expect(f).toMatch(/EXCEPTION WHEN OTHERS THEN[\s\S]+RELOAD_REFUSED/);
  });
  it('records the count and the total on the session and one event with before and after', () => {
    const f = fn('fn_lightning_auto_rebuy');
    expect(f).toContain('auto_rebuys = coalesce(ps.auto_rebuys, 0) + 1');
    expect(f).toContain('auto_rebuy_total = coalesce(ps.auto_rebuy_total, 0) + v_amount');
    expect(f).toContain("'auto_rebuy'");
    expect(f).toContain("'stack_before', v_stack");
    expect(f).toContain("'stack_after_delivery', round(v_stack + v_amount, 2)");
  });
});

describe('every substitution is asserted', () => {
  const rw = () =>
    SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION pg_temp.lp10_rewrite('),
      SQL.indexOf('$rw$;')
    );
  it('the rewriter reads production, counts each anchor, refuses a blind replace and reads back', () => {
    expect(rw()).toMatch(/v_src := pg_get_functiondef\(p_old::regprocedure\);/);
    expect(rw()).toMatch(/refusing to substitute blind/);
    expect(rw()).toMatch(/EXECUTE v_new;/);
    expect(rw()).toMatch(/does not read back carrying/);
  });
  it('rewrites exactly the five existing bodies, each in place (same signature)', () => {
    for (const sig of REWRITTEN) {
      const r = rewrite(sig);
      expect(r, sig).toContain(`'${sig}',\n  '${sig}',`);
    }
    expect(count(SQL, /SELECT pg_temp\.lp10_rewrite\(/g)).toBe(REWRITTEN.length);
  });
  it('the config gains the seven auto-rebuy keys with their defaults and clamps, off by default', () => {
    const r = rewrite('public.fn_lightning_config(uuid)');
    expect(r).toContain("'auto_rebuy_threshold_bb', 1, 0, 100, false");
    expect(r).toContain("'auto_rebuy_threshold_pct', 25, 1, 99, true");
    expect(r).toContain("'auto_rebuy_max_count', 3, 0, 100, true");
    expect(r).toContain("'auto_rebuy_session_cap', 0, 0, 1000000, false");
    expect(r).toContain("IN ('zero', 'below_bb', 'below_pct')");
    expect(r).toContain("IN ('initial', 'max')");
    expect(r).toContain("v_ar_on := false;");
    expect(r).toContain("'auto_rebuy_enabled', v_ar_on,");
  });
  it('the legality gains STOP_REQUESTED after the hand arms, so a stopper still playing reads IN_HAND', () => {
    const r = rewrite(
      'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'
    );
    expect(r).toMatch(/THEN 'IN_HAND'[\s\S]+WHEN f\.stop_requested_at IS NOT NULL THEN 'STOP_REQUESTED'/);
    expect(r).toContain("'stop_requested_at', c.stop_requested_at");
  });
  it('the pool door gains the responsible-gaming gate behind the anchor check', () => {
    const r = rewrite('public.fn_lightning_pool_enter(uuid,timestamp with time zone)');
    expect(r).toContain("fn_rg_require_not_excluded(s.user_id)");
    expect(r).toMatch(/IS DISTINCT FROM true THEN\s+RETURN NULL;/);
  });
  it('the reaper widens to stop requests, names the right reason, and never counts a stop as an expired disconnect', () => {
    const r = rewrite(
      'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'
    );
    expect(r).toContain('OR ps.stop_requested_at IS NOT NULL');
    expect(r).toContain("THEN 'stop_playing' ELSE 'disconnect_expired' END");
    expect(r).toContain("'stopped', s.stop_requested_at IS NOT NULL");
    expect(r).toContain("WHERE (x ->> 'stopped')::boolean IS NOT TRUE");
  });
  it('the reconnect snapshot gains the one stop key', () => {
    const r = rewrite('public.fn_lightning_reconnect_state(uuid)');
    expect(r).toContain("'stop_requested', ps.stop_requested_at IS NOT NULL,");
    expect(r).toContain('EXACTLY TEN KEYS');
  });
});

describe('law 10.5 and the live proofs', () => {
  it('no body reads is_horse or horse_id', () => {
    expect(CODE).not.toMatch(/\bis_horse\b|\bhorse_id\b/);
    expect(SQL).toMatch(/~ 'is_horse\|horse_id'\)\)/);
  });
  it('declares eighteen live proofs, every one a single line', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(18);
    for (const p of proofs) expect(p).not.toContain('\n');
  });
  it('the RNG review pins hidden information: the service-only windows, the card-free Lightning tables and the owner-scoped stores', () => {
    expect(SQL).toMatch(/fn_lightning_cluster_forensics[\s\S]+fn_lightning_hand_replay_check[\s\S]+fn_lightning_settlement_seats/);
    expect(SQL).toContain("column_name ~* 'card|deck|seed|hole'");
    expect(SQL).toContain("'hole_cards|hand_private_state|table_hole_cards'");
    expect(SQL).toContain("'table_hole_cards', 'hand_private_state'");
  });
});

describe('the proof harness and CI', () => {
  it('the harness runs the real chain through the migration under test on port 55557', () => {
    expect(HARNESS).toContain('LIGHTNING_P10_PORT:-55557');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('20261008050805_lightning_phase_9_disconnect_reconnect');
    expect(HARNESS).toContain('PASS: Lightning Phase 10');
  });
  it('CI runs the harness on shard 1 after the Phase 9 reconnect step', () => {
    const p9 = CI.indexOf('test-lightning-phase9-reconnect.sh');
    const p10 = CI.indexOf('test-lightning-phase10-rg-rebuy.sh');
    expect(p9).toBeGreaterThan(0);
    expect(p10).toBeGreaterThan(p9);
    const step = CI.slice(CI.lastIndexOf('- name:', p10), p10);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });
  it('the schema manifest fragment promises exactly the two new doors and the three columns', () => {
    expect([...FRAGMENT.functions].sort()).toEqual([...DOORS].sort());
    expect(FRAGMENT.tables).toEqual([]);
    expect(FRAGMENT.columns).toEqual({
      lightning_pool_session: ['stop_requested_at', 'auto_rebuys', 'auto_rebuy_total'],
    });
  });
  it('the changelog names both doors, the keys and the file, uses title case headings and no em dash', () => {
    for (const p of [
      ...DOORS,
      'auto_rebuy_enabled',
      'auto_rebuy_max_count',
      'stop_requested_at',
      'STOP_REQUESTED',
      'pool_player_left',
      FILE,
    ])
      expect(CHANGELOG, p).toContain(p);
    expect(CHANGELOG).not.toContain('—');
    for (const h of CHANGELOG.match(/^#{1,3} .+$/gm) ?? []) {
      for (const w of h.replace(/^#+ /, '').split(/\s+/)) {
        if (
          /^[a-z]/.test(w) &&
          ![
            'a',
            'an',
            'and',
            'the',
            'of',
            'to',
            'in',
            'on',
            'or',
            'by',
            'at',
            'for',
            'is',
            'its',
            'through',
            'with',
          ].includes(w)
        )
          throw new Error(`heading word not in title case: ${w} in ${h}`);
      }
    }
  });
});
