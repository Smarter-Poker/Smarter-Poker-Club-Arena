import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261003141857_stats_operational_quality_center.sql'),
  'utf8'
);
const worker = readFileSync(
  resolve(root, 'server/src/services/supabase/handProjection.ts'),
  'utf8'
);

describe('Phase 9 Stats operational quality contract', () => {
  it('is aggregate-only, service-only and bounded without a scheduled repair path', () => {
    expect(migration).toContain('ca_stats_operational_quality is service only');
    expect(migration).toContain("SET statement_timeout TO '5s'");
    expect(migration).toContain('missing_current_fact_receipts');
    expect(migration).toContain("'data_through', jsonb_build_object");
    expect(migration).toContain('last_projection_latency_seconds');
    expect(migration).toContain("'fact_projection', jsonb_build_object");
    expect(migration).toContain("'accepted_payloads'");
    expect(migration).toContain("'projection_receipts'");
    expect(migration).toContain('protocol1_private_facts_not_reconstructable');
    expect(migration).toContain('hands_still_pending');
    expect(migration).toContain("'available', false");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.ca_stats_operational_quality()');
    expect(migration).not.toMatch(/cron\.schedule|pg_cron|CREATE\s+TRIGGER/i);
    expect(migration).not.toMatch(
      /jsonb_build_object\([\s\S]{0,120}'(?:hand_id|club_id|player_id|table_id)'/
    );
  });

  it('persists sanitized final failure categories without changing queue ownership', () => {
    expect(worker).toContain("supabase.rpc('ca_record_stats_projection_failure'");
    expect(worker).toContain("'source_hash_conflict'");
    expect(worker).toContain("'existing_fact_conflict'");
    expect(worker).toContain("'existing_transfer_conflict'");
    expect(worker).toContain("'invalid_stats_payload'");
    expect(worker).toContain("'projection_rpc_failure'");
    expect(worker).not.toMatch(
      /ca_record_stats_projection_failure[\s\S]{0,500}(?:club_id|player_id|table_id|raw_error|payload)/
    );
  });
});
