import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));

const migration = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20261003132118_stats_preserve_authorized_club_scope.sql'
  ),
  'utf8'
);
const overviewAclMigration = readFileSync(
  join(__dirname, '..', 'supabase', 'migrations', '20261003144033_stats_overview_owner_acl.sql'),
  'utf8'
);
const pageSource = readFileSync(
  join(__dirname, '..', 'src', 'pages', 'PlayerStatsPage.tsx'),
  'utf8'
);
const pulseSource = readFileSync(join(__dirname, '..', 'src', 'hooks', 'useStatsPulse.ts'), 'utf8');

describe('authorized club-scoped Stats contract', () => {
  beforeEach(() => rpc.mockReset());

  it('keeps All Clubs on the installed contract and selects additive RPCs only for a club', async () => {
    const { statsRpcName, statsScopeArgs } = await import('../src/services/statsScope');
    expect(statsRpcName('ca_player_stats_overview_v2', null)).toBe('ca_player_stats_overview_v2');
    expect(statsScopeArgs('chips', null)).toEqual({ p_asset: 'chips' });
    expect(statsRpcName('ca_player_stats_overview_v2', 'club-1')).toBe(
      'ca_player_stats_overview_v2_by_club'
    );
    expect(statsScopeArgs('chips', 'club-1')).toEqual({
      p_asset: 'chips',
      p_club_id: 'club-1',
    });
  });

  it('routes fact readers to the selected club and sends the club id', async () => {
    const { StatsFactsService } = await import('../src/services/StatsFactsService');
    rpc.mockResolvedValueOnce({ data: { points: [], summary: {} }, error: null });
    await StatsFactsService.getEVCurve('user-1', 'chips', 30, 'club-1');
    expect(rpc).toHaveBeenCalledWith('ca_player_ev_curve_by_club', {
      p_user: 'user-1',
      p_days: 30,
      p_limit: 5000,
      p_asset: 'chips',
      p_club_id: 'club-1',
    });
  });

  it('authorizes every selected club from the signed-in identity and active membership', () => {
    expect(migration).toContain('PERFORM public.ca_assert_self(p_user);');
    expect(migration).toMatch(/m\.user_id\s*=\s*p_user/);
    expect(migration).toMatch(/m\.status IN \('active', 'approved'\)/);
    expect(migration).toMatch(/coalesce\(c\.lifecycle_status, 'active'\) <> 'retired'/);
    expect(migration).toMatch(/coalesce\(c\.asset, 'chips'\) = p_asset/);
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.ca_player_stats_shared_clubs');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.ca_player_stats_shared_overview_v1'
    );
    expect(migration).toContain("'visibility','shared_club'");
    expect(migration).toContain("vm.status IN ('active','approved')");
    expect(migration).toContain("tm.status IN ('active','approved')");
    expect(migration).toContain("coalesce(c.lifecycle_status,'active')<>'retired'");
  });

  it('keeps the All Clubs owner facade unavailable to anonymous callers', () => {
    const signature = 'public.ca_player_stats_overview_v2(uuid,integer,text,text)';
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,anon,authenticated;`
    );
    expect(migration).toContain(
      `GRANT EXECUTE ON FUNCTION ${signature} TO authenticated,service_role;`
    );
    expect(overviewAclMigration).toContain(
      `REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC,anon,authenticated;`
    );
    expect(overviewAclMigration).toContain(
      `GRANT EXECUTE ON FUNCTION ${signature}\n  TO authenticated,service_role;`
    );
  });

  it('ships every club-scoped reader used by the eight Stats tabs', () => {
    for (const name of [
      'ca_player_stats_overview_v2_by_club',
      'ca_player_hands_v2_by_club',
      'ca_player_stats_pulse_by_club',
      'ca_player_ev_curve_by_club',
      'ca_player_hand_grid_by_club',
      'ca_player_class_hands_by_club',
      'ca_player_nemesis_by_club',
      'ca_player_rake_stats_by_club',
      'ca_player_stats_hand_evidence',
    ]) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}`);
    }
  });

  it('sends the full evidence scope and keyset cursor through the typed service', async () => {
    const { StatsEvidenceService } = await import('../src/services/StatsEvidenceService');
    rpc.mockResolvedValueOnce({
      data: { hands: [], has_more: false, next_cursor: null, generated_at: '2026-10-03T00:00:00Z' },
      error: null,
    });
    await StatsEvidenceService.list(
      'user-1',
      'chips',
      'club-1',
      {
        variant: 'nlh',
        position: 'BTN',
        bigBlind: 2,
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-02T00:00:00Z',
        outcome: 'won',
        showdown: true,
        allIn: true,
        bigPots: true,
        noted: true,
        handClass: 'AKo',
        tournament: false,
        cashMetric: 'squeeze',
      },
      { played_at: '2026-10-01T12:00:00Z', hand_id: 'hand-9' },
      500
    );
    expect(rpc).toHaveBeenCalledWith('ca_player_stats_hand_evidence', {
      p_user: 'user-1',
      p_club_id: 'club-1',
      p_asset: 'chips',
      p_variant: 'nlh',
      p_position: 'BTN',
      p_big_blind: 2,
      p_from: '2026-10-01T00:00:00Z',
      p_to: '2026-10-02T00:00:00Z',
      p_outcome: 'won',
      p_showdown: true,
      p_all_in: true,
      p_big_pots: true,
      p_noted: true,
      p_hand_class: 'AKo',
      p_tournament: false,
      p_cash_metric: 'squeeze',
      p_cash_session_id: null,
      p_cursor_played_at: '2026-10-01T12:00:00Z',
      p_cursor_hand_id: 'hand-9',
      p_limit: 100,
    });
  });

  it('filters evidence before its deterministic bounded keyset page', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.ca_player_stats_hand_evidence'
    );
    const end = migration.indexOf('END;$function$;', start);
    const body = migration.slice(start, end);
    expect(body).toContain('AND (p_club_id IS NULL OR f.club_id=p_club_id)');
    expect(body).toContain('AND (v_position IS NULL OR upper(f.position)=v_position)');
    expect(body).toContain('AND (p_big_blind IS NULL OR f.big_blind=p_big_blind)');
    expect(body).toContain('AND (p_to IS NULL OR f.played_at<p_to)');
    expect(body).toContain('(f.played_at,f.hand_id)<(p_cursor_played_at,p_cursor_hand_id)');
    expect(body.indexOf('WHERE f.user_id=p_user')).toBeLessThan(body.indexOf('LIMIT v_limit+1'));
    expect(body).toContain('ORDER BY f.played_at DESC,f.hand_id DESC');
    expect(body).toContain('f.hole_cards own_hole_cards');
    expect(body).not.toContain('revealed_hole_cards');
    expect(body).not.toContain('n.note');
  });

  it('keeps direct client RPC names and argument lists aligned with database signatures', () => {
    expect(pageSource).toContain("statsRpcName('ca_player_stats_overview_v2', selectedClubId)");
    expect(pageSource).toContain("statsRpcName('ca_player_hands_v2', selectedClubId)");
    expect(pageSource).toContain("supabase.rpc('ca_player_stats_club_comparison'");
    expect(pageSource).toContain('...statsScopeArgs(statsScope, selectedClubId)');
    expect(pageSource).toContain('p_user: targetUserId');
    expect(pageSource).toContain('p_days: windowDays');
    expect(pageSource).toContain('p_asset: statsScope');
    expect(pulseSource).toContain("statsRpcName('ca_player_stats_pulse', clubId)");
    expect(pulseSource).toContain('...statsScopeArgs(scope, clubId)');
  });

  it('does not invent missing three-bet, hours, aggression, or historical coverage', () => {
    expect(migration).toContain("'three_bet_percent', 0");
    expect(migration).toContain("'three_bet_opportunities', NULL");
    expect(migration).toContain(
      "'aggression_factor', coalesce(round(aggro::numeric / nullif(passive, 0), 2), 0)"
    );
    expect(migration).toContain("'hours_played', false");
    expect(migration).toContain("'sessions', false");
    expect(migration).toContain("'sessions_reason', 'not_captured_in_ca_hand_facts'");
    expect(migration).toContain("'historical_club_breakdown_available', false");
    expect(migration).toContain("'all_clubs_contract_conservation_comparable',false");
    expect(migration).toContain(
      "'wtsd', coalesce(round(showdowns::numeric / nullif(saw_flop_hands, 0), 4), 0)"
    );
  });

  it('bounds every caller-provided date window', () => {
    expect(migration).not.toMatch(/make_interval\(days\s*=>\s*p_days\)/);
    expect(migration.match(/least\(greatest\(p_days,\s*1\),\s*3650\)/g)?.length).toBeGreaterThan(5);
  });

  it('separates total and cash hands in comparison arithmetic', () => {
    expect(migration).toContain('count(*)::integer total_hands');
    expect(migration).toContain(
      'count(*) FILTER (WHERE f.tournament_id IS NULL)::integer cash_hands'
    );
    expect(migration).toContain('coalesce(c.total_hands,0) hands');
    expect(migration).toContain('coalesce(c.cash_hands,0) cash_hands');
    expect(migration).toContain('net_bb_numerator/nullif(cash_hands,0)*100');
    expect(migration).toContain('coalesce(c.total_hands,0) dealt_denominator');
  });
});
