import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261003142631_stats_hand_evidence_cash_session.sql'),
  'utf8'
);

describe('final composed Stats evidence RPC', () => {
  it('has one public signature with metric and exact-session inputs', () => {
    expect(migration).toContain('p_cash_metric text DEFAULT NULL');
    expect(migration).toContain('p_cash_session_id uuid DEFAULT NULL');
    expect(migration).toContain('RENAME TO ca_player_stats_hand_evidence_base');
    expect(migration).toContain('FROM PUBLIC,anon,authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.ca_player_stats_hand_evidence(');
  });

  it('refuses overlaps and applies session identity and metric opportunity before keyset limit', () => {
    expect(migration).toContain("'evidence_status','overlap_unavailable'");
    expect(migration).toContain('AND o.club_id=v_session.club_id');
    expect(migration).toContain('o.cluster_id=v_session.cluster_id');
    expect(migration).toContain('o.table_id=v_session.table_id');
    expect(migration).toContain('f.played_at>=v_session.opened_at');
    expect(migration).toContain('t.cluster_id=v_session.cluster_id');
    expect(migration).toContain('f.table_id=v_session.table_id');
    expect(migration).toContain("WHEN 'three_bet' THEN f.three_bet_opportunity");
    expect(migration.indexOf("WHEN 'three_bet' THEN f.three_bet_opportunity")).toBeLessThan(
      migration.indexOf('LIMIT v_limit+1')
    );
  });
});
