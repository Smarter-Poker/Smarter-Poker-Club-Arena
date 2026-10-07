import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const sql = read('supabase/migrations/20261007024757_horse_accepted_roster_at_settlement.sql');
const probe = read('scripts/ci/probes/accepted-hand-roster-native.sql');
const runner = read('scripts/ci/test-accepted-hand-roster.py');

describe('P14.2: the accepted roster is produced inside the settlement transaction', () => {
  it('is one bounded transaction pinned to the current door preimage', () => {
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '2s'");
    expect(sql).toContain("'ad4eadeb4df8113db0ba2b598d219aaf'");
    expect(sql).toContain('ACCEPTED_ROSTER_DOOR_PREIMAGE_DRIFT');
    const calls = [
      ...sql.matchAll(
        /SELECT pg_temp\.ca_audit_subst\(\s*'([^']+)',\s*'([0-9a-f]{32})', '([0-9a-f]{32})'/g
      ),
    ];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(
      'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'
    );
    expect(sql.match(/\$o\$/g)).toHaveLength(10);
    expect(sql.match(/\$n\$/g)).toHaveLength(10);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBeGreaterThanOrEqual(4);
  });

  it('never puts the roster into the stored envelope the seal verifiers rebuild', () => {
    const news = [...sql.matchAll(/\$n\$([\s\S]*?)\$n\$/g)].map((m) => m[1]).join('\n');
    expect(news).not.toMatch(/v_payload\s*:=/);
    expect(news).not.toMatch(/jsonb_set\(\s*v_payload/);
    expect(news).not.toMatch(/SET\s+post_commit_payload/i);
    expect(news).toContain("OR p_post_commit_obligations ? 'accepted_actor_roster'");
  });

  it('cannot fail a hand: both producer calls are their own subtransaction', () => {
    const news = [...sql.matchAll(/\$n\$([\s\S]*?)\$n\$/g)].map((m) => m[1]).join('\n');
    expect(news.match(/EXCEPTION WHEN OTHERS THEN/g)).toHaveLength(2);
    expect(news).toContain("'roster_producer_error:' || v_roster_state");
    expect(news).toContain("'roster_replay_error:' || v_roster_state");
    expect(sql).toContain("v_reasons := ARRAY['roster_producer_error:' || v_state]");
    expect(sql).toContain("v_reasons := ARRAY['roster_record_error:' || v_state]");
  });

  it('keeps the discriminator private, insert-once and immutable', () => {
    expect(sql).toContain(
      'REVOKE ALL ON smarter_private.accepted_hand_rosters FROM PUBLIC, anon, authenticated, service_role'
    );
    expect(sql).toContain('ACCEPTED_ROSTER_IMMUTABLE');
    expect(sql).toContain('ACCEPTED_ROSTER_TRANSACTION_REQUIRED');
    expect(sql).toContain('ACCEPTED_ROSTER_RECEIPT_REQUIRED');
    expect(sql).not.toMatch(/accepted_hand_roster_\w+\([^)]*\)\s*\n\s*RETURNS[^$]*SECURITY DEFINER/);
    expect(sql).not.toMatch(/GRANT\s+\w+.*accepted_hand_roster/i);
  });

  it('reads is_horse as data and orders actors exactly as readRosterCapsule does', () => {
    expect(sql).toContain('ORDER BY j.user_id::text COLLATE "C"');
    expect(sql).toContain("'profiles_read_in_acceptance_transaction'");
    expect(sql).toContain("'classification_null'");
    expect(sql).toContain("'profile_missing'");
    expect(sql).toMatch(/to_char\(p_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\)/);
  });

  it('is qualified natively in the maintained accounting shard', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain(
      'python3 scripts/ci/test-accepted-hand-roster.py --pg-bin "$POKER_AUDIT_PG_BIN" --evidence artifacts/accepted-hand-roster'
    );
    expect(runner).toContain('ROSTER_PASSES = 56');
    expect(runner).toContain("DOOR_PREIMAGE = 'ad4eadeb4df8113db0ba2b598d219aaf'");
    for (const witness of [
      'silent horse',
      'post-only horse',
      'lawfully departed seat',
      'profile flips after acceptance',
      'roster_producer_error:XX001',
      'invalid_post_commit_obligations',
      'ACCEPTED_ROSTER_IMMUTABLE',
      'identical with or without the roster',
    ])
      expect(probe).toContain(witness);
    const manifest = JSON.parse(read('scripts/qualification/cash-native-hosted.manifest.json'));
    expect(manifest.files['.github/workflows/ci.yml'].sha256).toBe(
      createHash('sha256').update(readFileSync(resolve(root, '.github/workflows/ci.yml'))).digest('hex')
    );
  });
});
