/**
 * POSTGREST NEVER RERUNS A REFUSAL (2026-10-12).
 *
 * PostgREST 14 (production runs 14.5 and 14.18) re-runs a request whose
 * transaction ends in SQLSTATE 40001 on the same pooled connection, with no
 * backoff and no limit (Supabase: fixed only in PostgREST 16). A custom 40001
 * that the same request meets again never returns: 2026-10-06 (#6326, ten and
 * a half hours), 2026-10-11 (22,401 re-runs of one ticket refusal, 40 minutes
 * of pool exhaustion).
 *
 * Migration 20261012061427 read every remaining custom 40001 raise site in
 * public and smarter_private (186 sites in 99 functions) and moved each one a
 * re-run cannot clear: busy lanes, try-locks and in-flight requests to 55P03,
 * every other refusal to 55000. Fifteen sites in nine functions keep 40001,
 * each with its reason in the inventory fixture.
 *
 * This pins: the recorded bytes, the inventory and its counts, that every
 * converted site is in the migration and every kept site is not, that the
 * kept set is the exact set the migration proves on the live catalog, and
 * that the one SQL caller that matched the old code now matches the new one.
 * a-late-ticket-entry-expects-the-running-count.law.test.ts already refuses
 * any later migration that raises a custom 40001.
 * docs/changelog/2026-10-12-postgrest-never-reruns-a-refusal.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FILE = 'supabase/migrations/20261012061427_postgrest_never_reruns_a_refusal.sql';
const migration = readFileSync(FILE, 'utf8');
const inventory = JSON.parse(
  readFileSync('tests/fixtures/postgrest-never-reruns-a-refusal/inventory.json', 'utf8')
) as {
  postgrest_versions: string[];
  sites: Array<{
    signature: string;
    message: string;
    postgrest_roles: string[];
    trigger: boolean;
    reaches_postgrest_uncaught: boolean;
    decision: 'keep_40001' | 'to_55000' | 'to_55P03';
    reason?: string;
  }>;
};
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const sites = inventory.sites;
const kept = sites.filter((s) => s.decision === 'keep_40001');
const moved = sites.filter((s) => s.decision !== 'keep_40001');
const keptFunctions = [...new Set(kept.map((s) => s.signature))].sort();

/** The pinned (signature, preimage, postimage) rows of the install loop. */
const pins = [
  ...migration.matchAll(
    /^ {2}\('([a-z_]+\.[a-z0-9_]+\([^']*\))','([0-9a-f]{32})','([0-9a-f]{32})'\)/gm
  ),
].map((m) => ({ signature: m[1], pre: m[2], post: m[3] }));

/** The (signature, fragment, new code, expected count) rows of the site loop. */
const fragments = [
  ...migration.matchAll(
    /^ {2}\('([a-z_]+\.[a-z0-9_]+\([^']*\))',\$q\$([\s\S]*?)\$q\$,'(55000|55P03)',(\d+)\)/gm
  ),
].map((m) => ({ signature: m[1], fragment: m[2], code: m[3], count: Number(m[4]) }));

describe('postgrest never reruns a refusal', () => {
  it('is recorded byte-exact as applied (20261012061427)', () => {
    expect(md5(migration)).toBe('46475e9b54f85098853e3057075f7c43');
  });

  it('inventories every custom serialization failure the catalog held', () => {
    expect(inventory.postgrest_versions).toEqual(['14.5', '14.18']);
    expect(sites).toHaveLength(186);
    expect(new Set(sites.map((s) => s.signature)).size).toBe(99);
    expect(moved.filter((s) => s.decision === 'to_55000')).toHaveLength(138);
    expect(moved.filter((s) => s.decision === 'to_55P03')).toHaveLength(33);
    expect(kept).toHaveLength(15);
  });

  it('keeps 40001 only where a reason is written down', () => {
    expect(keptFunctions).toEqual([
      'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
      'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)',
      'public.fn_lock_tournament_launch_proof_parents(uuid[])',
      'public.fn_refuse_new_entries_while_frozen()',
      'public.fn_serialize_entry_statement()',
      'public.fn_settle_final_table_deal_atomic(uuid)',
      'public.fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
      'public.fn_settle_tournament_places_atomic(uuid,text)',
      'public.fn_union_pnl_original_frame()',
    ]);
    for (const site of kept) expect(site.reason, site.signature).toMatch(/.{60,}/);
    for (const site of moved) expect(site.reason, site.signature).toBeUndefined();
    // A kept site either never reaches PostgREST uncaught, or clears by itself.
    for (const site of kept.filter((s) => s.reaches_postgrest_uncaught)) {
      expect(site.message).toMatch(
        /^(TOURNAMENT_TRANSITION_BUSY|ENTRY_BOUNDARY_BUSY|pnl_frame_clock_crossed_twice)/
      );
    }
  });

  it('proves the same kept set on the live catalog it leaves behind', () => {
    const proof = migration.split('\n')[0];
    expect(proof.startsWith('-- @live-proof: NOT EXISTS')).toBe(true);
    for (const signature of keptFunctions) {
      expect(proof).toContain(`'${signature}'`);
      expect(migration.slice(migration.indexOf('DO $prove$'))).toContain(`'${signature}'`);
    }
    expect(proof.match(/'public\.[a-z_0-9]+\(/g)).toHaveLength(keptFunctions.length);
  });

  it('moves every busy lane to 55P03 and every other refusal to 55000', () => {
    const busy = new Set([
      'F06_HAND_DISPATCH_BUSY',
      'F06_ABORT_RETRY_PLAYER_LANE',
      'F06_RETRY_MAINTENANCE_LANE',
      'F06_RETIRED_CLAIM_BUSY',
      'F06_HISTORICAL_LOSS_ALLOWANCE_BUSY',
      'HAND_DISPOSAL_TABLE_BUSY',
      'F06_STRANDED_EVENT_OWNED',
      'HAND_SUBMISSION_ADMISSION_CHANGED: %',
      'Mutation is still in progress; retry with the same mutation id',
    ]);
    for (const site of moved) {
      expect(site.decision, site.message).toBe(busy.has(site.message) ? 'to_55P03' : 'to_55000');
    }
  });

  it('replaces exactly the moved sites, in exactly the pinned functions', () => {
    const movedFunctions = [...new Set(moved.map((s) => s.signature))].sort();
    const park =
      'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)';
    expect(pins.map((p) => p.signature).sort()).toEqual([...movedFunctions, park].sort());
    expect(pins).toHaveLength(91);
    for (const p of pins) expect(p.pre).not.toBe(p.post);
    for (const signature of keptFunctions) {
      expect(
        pins.some((p) => p.signature === signature),
        signature
      ).toBe(false);
    }
    // Every moved site is one fragment occurrence carrying its own message.
    const total = fragments.reduce((n, f) => n + f.count, 0);
    expect(total).toBe(moved.length + 1);
    for (const site of moved) {
      const code = site.decision === 'to_55P03' ? '55P03' : '55000';
      const head = site.message === '(none)' ? 'RAISE EXCEPTION USING' : site.message.slice(0, 30);
      expect(
        fragments.some(
          (f) => f.signature === site.signature && f.code === code && f.fragment.includes(head)
        ),
        `${site.signature} ${site.message}`
      ).toBe(true);
    }
    expect(migration).toContain(
      'IF v_changed NOT IN (0, 91) OR (v_changed = 91 AND v_sites <> 172)'
    );
  });

  it('moves the one SQL caller that waited on the old code to the new one', () => {
    expect(fragments).toContainEqual({
      signature:
        'public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)',
      fragment: 'EXCEPTION WHEN SQLSTATE <<C>> THEN',
      code: '55P03',
      count: 1,
    });
    expect(migration).toContain(
      "-- @live-proof: md5(pg_get_functiondef('public.fn_park_stopped_time_bank_custody(uuid,uuid,uuid,bigint,text,jsonb,jsonb,text,uuid,bigint)'::regprocedure)) = 'd446c24e2a40221b54c88375d590c61c'"
    );
  });

  it('changes only SQLSTATE literals, atomically, and refuses an unknown preimage', () => {
    expect(migration).toMatch(/\nBEGIN;\nSET LOCAL lock_timeout = '5s';[\s\S]*\nCOMMIT;\n$/);
    expect(migration).toContain("RAISE EXCEPTION 'RERUN_REFUSAL_PREIMAGE_CHANGED: %'");
    expect(migration).toContain('proacl IS NOT DISTINCT FROM acl_before');
    expect(migration).toContain('EXECUTE n;');
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|INSERT INTO|DELETE FROM|UPDATE public\.)\b/);
    expect(migration).not.toMatch(/USING\s+ERRCODE\s*=\s*'(?:40001|serialization_failure)'/i);
    for (const f of fragments) {
      expect(f.fragment.match(/<<[CS]>>/g), f.fragment).toHaveLength(1);
      expect(
        f.fragment.endsWith('<<C>>') || f.fragment.endsWith('<<S>>') || f.fragment.endsWith(' THEN')
      ).toBe(true);
    }
  });
});
