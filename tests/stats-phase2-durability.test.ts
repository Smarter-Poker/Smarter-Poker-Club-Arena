import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261003134650_stats_facts_outbox_and_corrections.sql'),
  'utf8'
);
const handHistory = readFileSync(
  resolve(root, 'server/src/services/supabase/handHistory.ts'),
  'utf8'
);
const handFacts = readFileSync(resolve(root, 'server/src/services/supabase/handFacts.ts'), 'utf8');
const handHistoryService = readFileSync(
  resolve(root, 'src/services/HandHistoryService.ts'),
  'utf8'
);
const contract = readFileSync(resolve(root, 'src/services/statsContract.ts'), 'utf8');
const retirement = readFileSync(
  resolve(root, 'supabase/migrations/20261003214510_retire_stats_fact_repair_door.sql'),
  'utf8'
);
const launchRepair = readFileSync(
  resolve(
    root,
    'supabase/migrations/20261004122156_keep_voided_stats_and_nullable_session_closes_honest.sql'
  ),
  'utf8'
);

describe('Phase 2 exact fact durability', () => {
  it('keeps private cards in the immutable service receipt, outside hand_history', () => {
    expect(handHistory).toContain('acceptedPostCommitFacts.stats_facts = statsFacts');
    expect(handHistory).toContain('collectOnly: true');
    expect(handHistory).toContain('Folded holdings never enter `row`/hand_history');
  });

  it('projects facts before the durable outbox claim can be deleted', () => {
    expect(migration).toContain('PERFORM public.ca_project_hand_stats_facts(v_h.id)');
    expect(migration).toContain('stats facts refused (source_hash_conflict)');
    expect(migration).toContain('stats facts refused (existing_fact_conflict)');
    expect(migration).toContain('stats facts refused (existing_transfer_conflict)');
  });

  it('has no repair loop and leaves unavailable history uninvented', () => {
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS public.ca_reconcile_missing_hand_facts(integer)'
    );
    expect(retirement).toContain('DROP TABLE IF EXISTS public.ca_hand_fact_reconcile_state');
    expect(retirement).not.toMatch(/cron\.schedule|CREATE\s+TRIGGER[^;]*reconcile/i);
    expect(migration).toContain('stats_facts_unavailable');
  });

  it('retains append-only correction, void and refund receipts', () => {
    expect(migration).toContain("kind IN ('correction','void','refund')");
    expect(migration).toContain('ca_hand_fact_revisions is append-only');
    expect(migration).toContain('hand fact revision refused (idempotency_conflict)');
    expect(migration).toContain("IF p_kind='void'");
    expect(launchRepair).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(launchRepair).toContain('DELETE FROM public.ca_hand_player_stat');
    expect(launchRepair).toContain('DELETE FROM public.ca_hand_player_idx');
    expect(launchRepair).toContain("is_winner=((v_result->>'net')::numeric>0)");
  });

  it('retains facts across history pruning and keeps privileged doors private', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS ca_hand_facts_hand_id_fkey');
    expect(migration).not.toMatch(
      /projection_receipts[\s\S]{0,180}REFERENCES public\.hand_history/
    );
    expect(migration).toContain('ca_own_hand_history_by_club');
    expect(migration).toContain("m.status IN ('active','approved')");
    expect(migration).toContain("coalesce(c.lifecycle_status,'active')<>'retired'");
    expect(migration).toContain('RETURNS TABLE(hand jsonb)');
    expect(migration).not.toContain('RETURNS SETOF public.hand_history');
    expect(handHistoryService).toContain("HAND_HISTORY_ARENA_RPC = 'ca_own_hand_history_by_club'");
    for (const signature of [
      'ca_project_hand_stats_facts(uuid)',
      'ca_append_hand_fact_revision(uuid,uuid,text,jsonb,text,uuid)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature}`);
    }
  });

  it('retains exact equity capture until the accepted hand commits', () => {
    expect(handFacts).toContain('input.collectOnly\n      ? peekEquity');
    expect(handHistory).toContain('releaseHandFactsCapture(params.tableId, params.handNumber)');
  });

  it('defines profit and BB/100 as settlement metrics with explicit mixed history', () => {
    expect(contract).toMatch(/total_profit:[\s\S]*?source: 'settlement'/);
    expect(contract).toMatch(/bb_per_100:[\s\S]*?source: 'settlement'/);
    expect(contract).toContain('reconstructed or mixed historical coverage');
  });
});
