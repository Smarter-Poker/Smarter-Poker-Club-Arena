import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const MIGRATION = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260831235995_stats_v2_foundation.sql'),
  'utf8'
);
const PAGE = readFileSync(resolve(ROOT, 'src/pages/PlayerStatsPage.tsx'), 'utf8');
const ROUTER = readFileSync(resolve(ROOT, 'server/src/router.ts'), 'utf8');

describe('Stats contract v2 security boundary', () => {
  it('makes the browser use only owner-asserting versioned RPCs', () => {
    expect(PAGE).toContain("rpc('ca_player_stats_overview_v2'");
    expect(PAGE).toContain("rpc('ca_player_hands_v2'");
    expect(PAGE).not.toContain("rpc('ca_player_stats_full'");
    expect(PAGE).not.toContain("rpc('ca_player_hands'");

    expect(MIGRATION).toMatch(
      /FUNCTION public\.ca_player_stats_overview_v2[\s\S]*?PERFORM public\.ca_assert_self\(p_user\)/
    );
    expect(MIGRATION).toMatch(
      /FUNCTION public\.ca_player_hands_v2[\s\S]*?PERFORM public\.ca_assert_self\(p_user\)/
    );
  });

  it('revokes both arbitrary-target legacy functions from browser roles', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_player_stats_full\(uuid, integer\)[\s\S]{0,100}PUBLIC, anon, authenticated;/
    );
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_player_hands\(uuid, text, integer\)[\s\S]{0,100}PUBLIC, anon, authenticated;/
    );
    expect(MIGRATION).toContain('legacy arbitrary-target Stats RPC remains reachable');
  });

  it('does not hydrate or request cross-profile statistics', () => {
    expect(PAGE).toContain('if (!targetUserId || !isOwnProfile) return;');
    expect(PAGE).toContain('Player Stats Are Private');
    expect(PAGE).toContain('No All-Club Financial');
  });
});

describe('Stats truth and reproducibility boundary', () => {
  it('records missing production index and rake definitions in a normal migration', () => {
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS public.ca_hand_player_idx');
    expect(MIGRATION).toContain('FUNCTION public.ca_refresh_hand_player_index');
    expect(MIGRATION).toContain('FUNCTION public.ca_player_rake_stats');
    expect(MIGRATION).toContain('FUNCTION public.ca_player_hand_rake_share');
  });

  it('returns explicit source quality and coverage metadata', () => {
    expect(MIGRATION).toContain("'contract_version', 2");
    expect(MIGRATION).toContain("'cash_money_source', 'reconstructed_actions'");
    expect(MIGRATION).toContain("'cash_money_exact', false");
    expect(MIGRATION).toContain("'historical_club_breakdown_available', false");
    expect(PAGE).toContain('Cash Result And BB/100 Use Reconstructed Hand Actions');
  });

  it('never substitutes legacy player_stats rows under a scoped range label', () => {
    expect(PAGE).not.toContain('loadLegacyStats');
    expect(PAGE).not.toContain('legacy_fallback');
  });
});

describe('false Assistant integration is absent', () => {
  it('has no client call, success claim, or engine route', () => {
    expect(PAGE).not.toContain('/assistant/leaks/detect');
    expect(PAGE).not.toContain('sent to your Personal Assistant');
    expect(ROUTER).not.toContain('/assistant/leaks/detect');
    expect(ROUTER).not.toContain('handleAssistantLeaksDetect');
  });
});
