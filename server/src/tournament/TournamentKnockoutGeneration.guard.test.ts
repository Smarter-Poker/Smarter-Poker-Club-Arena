/**
 * A zero-stack hand, its rebuy decision and its eventual elimination are one
 * immutable seat generation. These source laws prevent a delayed sweep from
 * applying an old bust to a newly purchased entry.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const SQL = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);
const REBUY_SQL = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260909205412_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
  ),
  'utf8'
);
const MANAGER = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');

const functionBody = (name: string): string => {
  const start = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = SQL.indexOf('$function$;', start);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  expect(end, `${name} must have a complete body`).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

describe('knockout generation authority', () => {
  it('captures the seat generation inside the accepted-hand transaction', () => {
    const atomic = functionBody('fn_ca_commit_hand_settlement_before_lease_generation');
    expect(atomic).toContain('INSERT INTO public.tournament_knockout_candidates');
    expect(atomic).toContain('v_seat.joined_at');
    expect(atomic).toContain(
      'ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING'
    );
    expect(atomic).not.toContain('ON CONFLICT DO NOTHING');
    expect(atomic).not.toContain('c2.seat_joined_at');
    expect(atomic.indexOf('INSERT INTO public.tournament_knockout_candidates')).toBeLessThan(
      atomic.indexOf('INSERT INTO public.hand_atomic_commits')
    );
  });

  it('makes a still-open database deadline an elimination refusal', () => {
    const plain = functionBody('fn_eliminate_tournament_player_atomic');
    const bounty = functionBody('fn_claim_tournament_bounty_elimination');
    for (const body of [plain, bounty]) {
      expect(body).toContain('v_candidate.rebuy_prompt_until');
      expect(body).toContain('v_candidate.rebuy_prompt_until>clock_timestamp()');
      expect(body).toContain("'reason','rebuy_decision_open'");
    }
  });

  it('creates every prompt from the same level, minute and add-on window as purchase', () => {
    const atomic = functionBody('fn_ca_commit_hand_settlement_before_lease_generation');
    expect(atomic).toContain('public.fn_ca_tournament_rebuy_window(v_tournament_id)');
    expect(atomic).toContain("(v_rebuy_window->>'prompt_until')::timestamptz");
    expect(atomic).not.toMatch(/v_rebuy_cap|addon_levels/);

    const policyStart = REBUY_SQL.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_tournament_rebuy_window('
    );
    const policyEnd = REBUY_SQL.indexOf('$tournament_rebuy_window$;', policyStart);
    const policy = REBUY_SQL.slice(policyStart, policyEnd);
    expect(policyStart).toBeGreaterThan(-1);
    expect(policyEnd).toBeGreaterThan(policyStart);
    expect(policy).toContain('v_t.current_level<v_level_cap');
    expect(policy).toContain('make_interval(mins=>v_t.late_reg_mins)');
    expect(policy).toContain('v_t.addon_period_started_at');
    expect(policy).toContain('v_t.addon_period_ends_at');
    expect(REBUY_SQL).toContain(
      'v_rebuy_window:=public.fn_ca_tournament_rebuy_window(p_tournament_id)'
    );
  });

  it('consumes the exact candidate in the payment/status transaction', () => {
    const plain = functionBody('fn_eliminate_tournament_player_atomic');
    const bounty = functionBody('fn_claim_tournament_bounty_elimination');
    expect(plain).toContain('fn_eliminate_player_legacy_candidate_20260907');
    expect(bounty).toContain('fn_claim_bounty_legacy_candidate_20260907');
    for (const body of [plain, bounty]) {
      expect(body).toContain("SET state='eliminated'");
      expect(body).toContain("c.id=v_candidate.id AND c.state='pending'");
      expect(body).toContain('serialization_failure');
    }
  });

  it('selects the latest globally sequenced candidate, never a pending row or chair', () => {
    const plain = functionBody('fn_eliminate_tournament_player_atomic');
    const bounty = functionBody('fn_claim_tournament_bounty_elimination');
    for (const body of [plain, bounty]) {
      expect(body).toContain('fn_ca_latest_committed_knockout_candidate');
      expect(body).toContain("k.status='succeeded'");
      expect(body).toContain("AND c.state<>'rebought'");
      expect(body).toContain("'unresolved_knockout_generation_chain'");
      expect(body).toContain('AND c.hand_number>v_candidate.hand_number');
      expect(body).toContain('AND c.hand_number<v_candidate.hand_number');
      expect(body).not.toContain("ORDER BY (c.state='pending') DESC");
      expect(body).not.toContain("ORDER BY (k.result->>'hand_number')::bigint DESC");
      expect(body).not.toMatch(/SELECT max\(s\.joined_at\)/);
    }
  });

  it('never treats a missing candidate from an atomic hand as legacy evidence', () => {
    const plain = functionBody('fn_eliminate_tournament_player_atomic');
    const bounty = functionBody('fn_claim_tournament_bounty_elimination');
    for (const body of [plain, bounty]) {
      expect(body).toContain('FROM public.hand_atomic_commits');
      expect(body).toContain("'atomic_knockout_candidate_missing'");
      expect(body).toContain("'knockout_candidate_required'");
      expect(body).not.toContain("'knockout_evidence_not_found'");
    }
    expect(plain).toContain("k.status='succeeded'");
    expect(plain).toContain('WHERE a.table_id=v_candidate.table_id');
    expect(plain).toContain('AND a.hand_number=v_candidate.hand_number');
    expect(plain).toContain('AND a.hand_id=v_candidate.hand_id');
    expect(plain).toContain("v_settlement_hand_text:=v_atomic.stack_result->>'hand_id'");
    expect(plain).toContain('AND k.hand_id=v_settlement_hand_id');
    expect(bounty).toContain('WHERE a.table_id=v_candidate.table_id');
    expect(bounty).toContain('AND a.hand_number=v_candidate.hand_number');
    expect(bounty).toContain('AND a.hand_id=v_candidate.hand_id');
    expect(bounty).toContain('AND k.hand_id=v_settlement_hand_id');
    const bountyCore = functionBody('fn_claim_bounty_legacy_candidate_20260907');
    expect(bountyCore).toContain('WHERE a.table_id=p_table_id');
    expect(bountyCore).toContain('AND a.hand_id=p_hand_id');
    expect(bountyCore).toContain('AND k.hand_id=v_settlement_hand_id');
    expect(bountyCore).toContain('AND h.created_at>=p_seat_joined_at');
    expect(bountyCore).toContain("'atomic_knockout_evidence_required'");
    expect(bountyCore).not.toContain("'seat_generation_not_found'");
  });

  it('accepts the canonical UUID emitted by the deterministic settlement hash', () => {
    const canonicalUuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    const latestStart = REBUY_SQL.indexOf('public.fn_ca_latest_committed_knockout_candidate(');
    const latestEnd = REBUY_SQL.indexOf('$latest_committed_knockout_candidate$;', latestStart);
    expect(latestStart).toBeGreaterThan(-1);
    expect(latestEnd).toBeGreaterThan(latestStart);
    const bodies = [
      REBUY_SQL.slice(latestStart, latestEnd),
      functionBody('fn_eliminate_tournament_player_atomic'),
      functionBody('fn_claim_tournament_bounty_elimination'),
      functionBody('fn_claim_bounty_legacy_candidate_20260907'),
    ];
    for (const body of bodies) {
      expect(body).toContain(canonicalUuid);
      const identityCheck = body.indexOf(canonicalUuid);
      expect(body.lastIndexOf('v_settlement_hand_text', identityCheck)).toBeGreaterThan(-1);
    }
  });

  it('does not resurrect the retired rebuy hook or let elimination invent a rebuy', () => {
    expect(SQL).not.toContain('CREATE OR REPLACE FUNCTION public.fn_after_tournament_rebuy(');
    expect(functionBody('fn_eliminate_tournament_player_atomic')).not.toContain(
      "SET state='rebought'"
    );
    expect(functionBody('fn_claim_tournament_bounty_elimination')).not.toContain(
      "SET state='rebought'"
    );
  });

  it('retains global-hand and immutable entry-generation uniqueness', () => {
    expect(SQL).not.toMatch(
      /DROP CONSTRAINT(?: IF EXISTS)?\s+tournament_knockout_candidate_tournament_id_eliminated_user_key/
    );
    expect(SQL).not.toMatch(
      /DROP CONSTRAINT(?: IF EXISTS)?\s+tournament_bounty_obligations_tournament_id_eliminated_user_key/
    );
    expect(SQL).toContain('hand_atomic_commits_hand_number_key');
    expect(SQL).toContain('hand_projection_outbox_hand_number_key');
    expect(SQL).toContain('tournament_knockout_candidate_tournament_id_hand_number_eli_key');
    expect(SQL).toContain('tournament_bounty_obligations_tournament_id_hand_number_eli_key');
  });

  it('does not reconstruct stale tournament hand input from payment history', () => {
    const stacks = functionBody('fn_ca_settle_hand_stacks_absolute');
    expect(stacks).toContain('paid seat/roster generations must be reloaded before dealing');
    expect(stacks).not.toContain('FROM public.wallet_transactions');
    expect(stacks).not.toContain('SELECT max(k.completed_at)');
    expect(stacks).not.toMatch(/v_(?:grants|explained|prev_settled)/);
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

  it('derives runtime bounty identity from the latest candidate and exact atomic hand', () => {
    const loader = sliceMethod(MANAGER, 'loadPersistedBountyEvidence(');
    expect(loader).toContain(".from('tournament_knockout_candidates')");
    expect(loader).toContain(".eq('tournament_id', this.tournamentId)");
    expect(loader).toContain(".eq('eliminated_user_id', userId)");
    expect(loader).toContain(".order('hand_number', { ascending: false })");
    expect(loader).not.toContain(".eq('state', 'pending')");
    expect(loader).toContain("candidate?.state !== 'pending'");
    expect(loader).toContain(".from('hand_atomic_commits')");
    expect(loader).toContain(".eq('table_id', tableId)");
    expect(loader).toContain(".eq('hand_number', handNumber)");
    expect(loader).toContain(".eq('hand_id', handId)");
    expect(loader).toContain("String(atomic?.hand_id ?? '') !== handId");
    expect(loader).not.toContain(".from('settlement_idempotency_keys')");
    const historyAt = loader.indexOf(".from('hand_history')");
    const history = loader.slice(historyAt, loader.indexOf('.maybeSingle()', historyAt));
    expect(history).toContain(".eq('id', handId)");
    expect(history).toContain(".eq('table_id', tableId)");
    expect(history).toContain(".eq('hand_number', handNumber)");
  });

  it('lets a live seat veto a candidate but never select its bounty generation', () => {
    const loader = sliceMethod(MANAGER, 'loadPersistedBountyEvidence(');
    expect(loader).toContain(".from('table_seats')");
    expect(loader).toContain(".is('left_at', null)");
    expect(loader).toContain(
      "Date.parse(String(live.joined_at ?? '')) !== Date.parse(seatJoinedAt)"
    );
    expect(loader).toContain('Number(live.stack) !== 0');
    expect(MANAGER).not.toContain('lastTournamentTableForUser(');
    expect(MANAGER).not.toContain('tournamentTableForUser(');
  });

  it('reloads the bounty obligation by exact event, user and hand identity', () => {
    const eliminate = sliceMethod(MANAGER, 'protected async eliminatePlayer(');
    const obligationAt = eliminate.indexOf(".from('tournament_bounty_obligations')");
    expect(obligationAt).toBeGreaterThan(-1);
    const reload = eliminate.slice(obligationAt, eliminate.indexOf('.maybeSingle()', obligationAt));
    expect(reload).toContain(".eq('tournament_id', this.tournamentId)");
    expect(reload).toContain(".eq('eliminated_user_id', userId)");
    expect(reload).toContain(".eq('table_id', bountyEvidence!.tableId)");
    expect(reload).toContain(".eq('hand_number', bountyEvidence!.handNumber)");
    expect(reload).toContain(".eq('hand_id', bountyEvidence!.handId)");
    expect(reload).not.toContain(".eq('seat_joined_at'");
    expect(eliminate).toContain('p_seat_joined_at: bountyEvidence!.seatJoinedAt');
  });
});
