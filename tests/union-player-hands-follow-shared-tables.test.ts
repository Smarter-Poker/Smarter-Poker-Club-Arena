/**
 * Club Data attributes a union player to one member club, while shared table
 * hands are projected under the union-root club id. All three player readers
 * must therefore intersect the attributed users with one deduplicated
 * physical scope: union root plus its member clubs. Standalone clubs keep
 * their one-club scope.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261006012714_union_player_hands_follow_shared_tables.sql'
  ),
  'utf8'
);

const NEW_HANDS = SQL.match(/\$new_hands\$([\s\S]*?)\$new_hands\$/)?.[1] ?? '';

describe('union player hands follow their shared tables', () => {
  it('patches exactly the three player readers from measured live preimages', () => {
    const signatures = [
      'public.ca_club_player_breakdown(uuid,date,date,integer)',
      'public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)',
      'public.ca_club_player_export_start(uuid,date,date,text,uuid)',
    ];
    const preimages = [
      '283858d1274095f0a61103d745f7c34b',
      '980556d672f194b1b190e379d75321bb',
      'e095ebb3a4f0214110abb5e7cd79baf5',
    ];
    const postimages = [
      '121a71892c21a33fcccde7099337d2c0',
      '171060d16ed798d1a185080d1a9334cd',
      'ce83a312514da0262ecead6ef1d49da8',
    ];

    for (const signature of signatures) expect(SQL).toContain(signature);
    for (const hash of [...preimages, ...postimages]) expect(SQL).toContain(hash);
    expect(SQL.match(/::regprocedure,/g)).toHaveLength(3);
    expect(SQL.match(/^-- @live-proof:/gm)).toHaveLength(3);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('keeps standalone scope local and deduplicates union root plus member clubs', () => {
    expect(NEW_HANDS).toContain('SELECT p_club_id AS club_id WHERE v_union IS NULL');
    expect(NEW_HANDS).toContain('SELECT v_union WHERE v_union IS NOT NULL');
    expect(NEW_HANDS).toContain('SELECT uc.club_id FROM public.union_clubs uc');
    expect(NEW_HANDS).toContain('WHERE v_union IS NOT NULL AND uc.union_id=v_union');
    expect(NEW_HANDS.match(/^    UNION$/gm)).toHaveLength(2);
    expect(NEW_HANDS).not.toContain('UNION ALL');
    expect(NEW_HANDS).toContain('JOIN att_club a ON a.user_id=s.user_id');
    expect(NEW_HANDS).toContain('JOIN hand_clubs hc ON hc.club_id=s.club_id');
    expect(NEW_HANDS).not.toContain('s.club_id=p_club_id');
  });

  it('refuses body, owner, ACL, security, volatility, config, or return drift', () => {
    expect(SQL).toContain('UNION_PLAYER_HANDS_PREIMAGE');
    expect(SQL).toContain('UNION_PLAYER_HANDS_REWRITE');
    expect(SQL).toContain('UNION_PLAYER_HANDS_POSTIMAGE');
    expect(SQL).toContain("v_owner IS DISTINCT FROM 'postgres'");
    expect(SQL).toContain('v_security_definer IS DISTINCT FROM true');
    expect(SQL).toContain('v_volatility IS DISTINCT FROM v_row.volatility');
    expect(SQL).toContain("'{search_path=public}'::text");
    expect(SQL).toContain('\'{"search_path=public, pg_temp",statement_timeout=120s}\'::text');
    expect(SQL).toContain(
      "'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'"
    );
    expect(SQL).toContain("v_return_type IS DISTINCT FROM 'jsonb'::regtype");
    expect(SQL).toContain('v_returns_set IS DISTINCT FROM false');
  });

  it('retains horse privacy and the immutable export concurrency/expiry guards', () => {
    expect(SQL).toContain("position('public.fn_can_see_horse_flag(p_club_id)' IN v_definition)");
    expect(SQL).toContain("position('pg_try_advisory_xact_lock' IN v_definition)");
    expect(SQL).toContain("position('FOR UPDATE OF stale_row SKIP LOCKED' IN v_definition)");
    expect(SQL).toContain("position('active_slot.user_id = v_user' IN v_definition)");
    expect(SQL).toContain(
      "position(\n              'public.ca_prune_expired_club_data_exports(2000)' IN v_definition"
    );
  });

  it('changes no persisted facts and adds no repair loop', () => {
    expect(SQL).not.toMatch(/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\./im);
    expect(SQL).not.toMatch(/cron\.schedule|pg_cron/i);
    expect(SQL).not.toMatch(/backfill|reconcile|redrive/i);
  });
});
