import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261003140344_stats_cash_opportunity_facts.sql'),
  'utf8'
);
const phase2Migration = readFileSync(
  resolve(root, 'supabase/migrations/20261003134650_stats_facts_outbox_and_corrections.sql'),
  'utf8'
);
const facts = readFileSync(resolve(root, 'server/src/services/supabase/handFacts.ts'), 'utf8');
const settlement = readFileSync(
  resolve(root, 'server/src/engine/ServerTableEngineSettlement.ts'),
  'utf8'
);
const service = readFileSync(resolve(root, 'src/services/StatsFactsService.ts'), 'utf8');
const page = readFileSync(resolve(root, 'src/pages/PlayerStatsPage.tsx'), 'utf8');
const performance = readFileSync(resolve(root, 'src/pages/stats/PerformanceTab.tsx'), 'utf8');

describe('Phase 6 canonical cash opportunity contract', () => {
  it('carries deal-time stacks and ordered-action facts in payload v2', () => {
    expect(settlement).not.toContain('dealtStacksAtDeal: snap.dealtStacks');
    expect(facts).toContain('dealtStacksAtDeal');
    expect(facts).toContain('version: 2');
    expect(facts).toContain('effective_stack_bb_at_deal');
    expect(facts).toContain('hero_in_position');
    expect(facts).toContain('three_bet_opportunity');
    expect(facts).toContain('probe_opportunity');
  });

  it('keeps unavailable history nullable and exposes exact denominators', () => {
    expect(migration).toContain('three_bet_opportunity boolean');
    expect(migration).not.toMatch(/three_bet_opportunity boolean[^,;]*DEFAULT/i);
    expect(migration).toContain("coalesce(v_stats->>'version','') NOT IN ('1','2')");
    expect(phase2Migration).toContain("@>\n         (expected-'created_at'-'source_hash'");
    expect(migration).toContain(
      "'unavailable_hands',count(*) FILTER (WHERE three_bet_opportunity IS NULL)"
    );
    expect(migration).toContain("'opportunities',count(*) FILTER(WHERE squeeze_opportunity)");
    expect(migration).toContain('CASE WHEN p_days IS NULL THEN NULL');
    expect(migration).toContain('v_from IS NULL OR f.played_at>=v_from');
  });

  it('is self-only, current-club authorized, and leaks no public execute', () => {
    expect(migration).toContain('p_user IS DISTINCT FROM auth.uid()');
    expect(migration).toContain('ca_assert_player_stats_club(p_user,p_club,p_asset)');
    expect(migration).toContain("coalesce(c.lifecycle_status,'active')<>'retired'");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.ca_player_cash_opportunity_stats(uuid,integer,text,text,uuid) FROM PUBLIC,anon'
    );
  });

  it('filters exact metric opportunities before the bounded evidence page', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.ca_player_stats_hand_evidence'
    );
    const body = migration.slice(start);
    expect(body).toContain('p_cash_metric text DEFAULT NULL');
    expect(body).toContain("'three_bet','four_bet','steal','squeeze','blind_defense','cbet_flop'");
    expect(body).toContain("WHEN 'three_bet' THEN f.three_bet_opportunity");
    expect(body).toContain("WHEN 'three_bet' THEN f.three_bet");
    expect(body.indexOf('f.tournament_id IS NULL AND CASE v_cash_metric')).toBeLessThan(
      body.indexOf('LIMIT v_limit+1')
    );
    expect(body).toContain('cash_metric_action');
  });

  it('wires the selected club, range, timezone and exact evidence route into Performance', () => {
    expect(service).toContain("supabase.rpc('ca_player_cash_opportunity_stats'");
    expect(service).toContain('p_days: days == null ? null');
    expect(page).toContain('StatsFactsService.getCashOpportunityStats(');
    expect(page).toContain('buildStatsCashEvidencePath(metric, {');
    expect(page).toContain('asset: statsScope');
    expect(page).toContain('cashOpportunityStats={cashOpportunityStats}');
    expect(performance).toContain('<CashIntelligencePanel');
    expect(performance).toContain('exactThreeBet.actions / exactThreeBet.opportunities');
  });
});
