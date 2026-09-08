/**
 * A zero-stack hand, its rebuy decision and its eventual elimination are one
 * immutable seat generation. These source laws prevent a delayed sweep from
 * applying an old bust to a newly purchased entry.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql'
  ),
  'utf8'
);

const functionBody = (name: string): string => {
  const start = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = SQL.indexOf('$function$;', start);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  expect(end, `${name} must have a complete body`).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

describe('knockout generation authority', () => {
  it('captures the seat generation inside the accepted-hand transaction', () => {
    const atomic = functionBody('fn_ca_commit_hand_settlement');
    expect(atomic).toContain('INSERT INTO public.tournament_knockout_candidates');
    expect(atomic).toContain('v_seat.joined_at');
    expect(atomic.indexOf('INSERT INTO public.tournament_knockout_candidates')).toBeLessThan(
      atomic.indexOf('INSERT INTO public.hand_atomic_commits')
    );
  });

  it('makes a still-open database deadline an elimination refusal', () => {
    const plain = functionBody('fn_eliminate_tournament_player_atomic');
    const bounty = functionBody('fn_claim_tournament_bounty_elimination');
    for (const body of [plain, bounty]) {
      expect(body).toContain("v_candidate.state='pending'");
      expect(body).toContain('v_candidate.rebuy_prompt_until>clock_timestamp()');
      expect(body).toContain("'reason','rebuy_decision_open'");
    }
  });

  it('consumes the exact candidate in the payment/status transaction', () => {
    const plain = functionBody('fn_eliminate_tournament_player_atomic');
    const bounty = functionBody('fn_claim_tournament_bounty_elimination');
    expect(plain).toContain('fn_eliminate_player_legacy_candidate_20260907');
    expect(bounty).toContain('fn_claim_bounty_legacy_candidate_20260907');
    for (const body of [plain, bounty]) {
      expect(body).toContain("SET state='eliminated'");
      expect(body).toContain("c.state IN ('pending','eliminated')");
      expect(body).toContain('serialization_failure');
    }
  });

  it('never treats a missing candidate from an atomic hand as legacy evidence', () => {
    const plain = functionBody('fn_eliminate_tournament_player_atomic');
    const bounty = functionBody('fn_claim_tournament_bounty_elimination');
    for (const body of [plain, bounty]) {
      expect(body).toContain('FROM public.hand_atomic_commits');
      expect(body).toContain("'atomic_knockout_candidate_missing'");
    }
    expect(plain).toContain("k.status='succeeded'");
    expect(plain).toContain("k.result->'written' ? p_user_id::text");
  });

  it('closes the same pending generation when a rebuy commits', () => {
    const rebuy = functionBody('fn_after_tournament_rebuy');
    expect(rebuy).toContain("c.state='pending'");
    expect(rebuy).toContain("SET state='rebought'");
    expect(rebuy).toContain('resolved_at=clock_timestamp()');
  });

  it('exposes only the guarded RPC names to the service process', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_eliminate_player_legacy_candidate_20260907\([\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_claim_bounty_legacy_candidate_20260907\([\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_eliminate_tournament_player_atomic\([\s\S]*?TO service_role;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_claim_tournament_bounty_elimination\([\s\S]*?TO service_role;/
    );
  });
});
