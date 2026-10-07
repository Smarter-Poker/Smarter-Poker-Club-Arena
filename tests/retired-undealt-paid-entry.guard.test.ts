import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const folder = 'scripts/ci/fixtures/retired-paid-entry/';
const manifest = JSON.parse(readFileSync(folder + 'source-manifest.json', 'utf8'));
const source = readFileSync(
  'supabase/migrations/20261007024455_a_retired_undealt_paid_entry_retains_its_original_seat_trans.sql',
  'utf8'
);
describe('Original undealt paid entry custody', () => {
  it('keeps the qualified exact migration and native inputs bound', () => {
    for (const [file, sha] of Object.entries(manifest.files))
      expect(createHash('sha256').update(readFileSync(file)).digest('hex'), file).toBe(sha);
    expect(manifest.scope).toContain('isolated PG17.6');
  });
  it('restores only the immutable original paid chairs through the ordinary owner', () => {
    expect(source).toContain("session_user<>'postgres' OR auth.role() IS NOT NULL");
    expect(source).toContain(
      "public.fn_assign_tournament_player_seat_atomic(p_tournament_id,(e->'roster'->>'user_id')::uuid"
    );
    expect(source).toContain('UNDEALT_PAID_ENTRY_SPIN_EFFECT_CHANGED');
    expect(source).toContain('UNDEALT_PAID_ENTRY_RECEIPT_IMMUTABLE');
    expect(source).not.toMatch(
      /UPDATE\s+public\.(profiles|users|player_wallets|club_members)|INSERT\s+INTO\s+public\.(chip_ledger|wallet_transactions)/i
    );
  });
  it('acquires caps and missions before original event and chair row locks', () => {
    expect(source.indexOf("'table_cap:'")).toBeLessThan(
      source.indexOf('SELECT to_jsonb(t) INTO got FROM public.tournaments')
    );
    expect(source.indexOf('public.fn_lock_daily_mission_user')).toBeLessThan(
      source.indexOf('SELECT to_jsonb(t) INTO got FROM public.tournaments')
    );
    expect(source).toContain('IS DISTINCT FROM true');
  });
  it('retains all native refusal and atomic second-assignment rollback cases', () => {
    const probe = readFileSync(folder + 'negative-native.sql', 'utf8');
    for (const name of [
      'stale-lease',
      'unknown-lease',
      'wrong-auth-role',
      'foreign-chair',
      'missing-chair',
      'changed-funding',
      'changed-entitlement',
      'foreign-generation',
      'retirement-replaced',
    ])
      expect(probe).toContain('NATIVE_REFUSAL_PASS ' + name);
    expect(probe).toContain('NATIVE_WHOLE_OWNER_ROLLBACK_PASS');
    expect(probe).toContain('before_image IS DISTINCT FROM after_image');
  });
  it('preserves closed identity and original receipt-only replay', () => {
    expect(source).toContain("p.horse_status='disabled' AND p.status='deleted'");
    expect(source).toContain('UNDEALT_PAID_ENTRY_REPLAY_CHANGED');
    for (const role of ['anon', 'authenticated', 'service_role']) expect(source).toContain(role);
    expect(source).toContain('-- @live-proof original_undealt_paid_entry_custody');
  });
});
