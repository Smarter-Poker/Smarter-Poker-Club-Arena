import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const eliminations = read('src/tournament/TournamentManagerEliminations.ts');
const atomicElimination = read(
  '../supabase/migrations/20260908042000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
);
const terminalSettlement = read(
  '../supabase/migrations/20260908042400_tournament_places_settle_and_complete_atomically.sql'
);

const sqlFunction = (source: string, name: string): string => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`SQL function ${name} is missing`);
  const bodyStart = source.indexOf('AS $function$', start);
  const end = source.indexOf('$function$;', bodyStart);
  if (bodyStart < 0 || end < 0) throw new Error(`SQL function ${name} has no complete body`);
  return source.slice(start, end + '$function$;'.length);
};

describe('Bubble Protection is paid only by the finalized tournament batch', () => {
  const eliminate = sliceMethod(
    eliminations,
    'eliminatePlayer(\n    userId: string,\n    position: number,\n    allowCompletingClaim = false\n  ): Promise<boolean>'
  );
  const ordinary = sqlFunction(atomicElimination, 'fn_eliminate_tournament_player_atomic');
  const bounty = sqlFunction(atomicElimination, 'fn_claim_tournament_bounty_elimination');
  const prepare = sqlFunction(terminalSettlement, 'fn_prepare_tournament_place_obligations');
  const settle = sqlFunction(terminalSettlement, 'fn_settle_tournament_places_atomic');

  it('submits zero to both provisional elimination paths and has no side payer', () => {
    expect(eliminate).toContain('const bubbleRefund = 0;');
    expect(eliminate.match(/p_bubble_refund: bubbleRefund/g)).toHaveLength(2);
    expect(eliminate).not.toMatch(/bubble_protection === true|configuredRefund|paidPlaces \+ 1/);
    expect(eliminate).not.toMatch(
      /settleTournamentObligation|fn_settle_tournament_obligation|bubble_protection_paid/
    );
  });

  it('accepts a lost bounty response only when the durable row preserves zero', () => {
    expect(eliminate).toMatch(
      /\.select\(\s*'id,table_id,hand_id,hand_number,mode,state,knocker_user_id,claimants,position,prize,bubble_refund'/
    );
    expect(eliminate).toContain(
      'Math.round(Number(row.bubble_refund) * 100) === Math.round(bubbleRefund * 100)'
    );
    expect(bounty).toContain('v_existing.bubble_refund<>round(p_bubble_refund,2)');
  });

  it('replays an ordinary elimination only after transport ambiguity and requires an exact receipt', () => {
    const request = eliminate.indexOf('const eliminationRequest = {');
    const firstCall = eliminate.indexOf(
      "let eliminationResponse = await supabase.rpc(\n        'fn_eliminate_tournament_player_atomic'",
      request
    );
    const transportOnly = eliminate.indexOf('if (eliminationResponse.error)', firstCall);
    const exactReplay = eliminate.indexOf(
      "eliminationResponse = await supabase.rpc(\n          'fn_eliminate_tournament_player_atomic'",
      transportOnly
    );
    const receipt = eliminate.indexOf('const eliminationReceiptAccepted', exactReplay);

    expect(request).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(request);
    expect(transportOnly).toBeGreaterThan(firstCall);
    expect(exactReplay).toBeGreaterThan(transportOnly);
    expect(receipt).toBeGreaterThan(exactReplay);
    expect(eliminate).toMatch(
      /update\.ok === true && \(update\.claimed === true \|\| update\.already === true\)/
    );
  });

  it.each([
    ['ordinary', ordinary],
    ['bounty', bounty],
  ])(
    '%s elimination rejects money proposals and cannot touch place or Bubble money',
    (_kind, fn) => {
      expect(fn).toMatch(
        /IF p_bubble_refund <> 0 THEN[\s\S]*?'bubble_refund_requires_finalized_batch'/
      );
      expect(fn).not.toMatch(
        /fn_settle_tournament_obligation|public\.tournament_obligations|public\.tournament_payouts/
      );
    }
  );

  it('derives the sole stone-bubble holder and exact refund after finalization', () => {
    expect(prepare).toMatch(
      /IF NOT v_t\.prize_pool_finalized[\s\S]*?'prize_pool_is_not_funded_and_finalized'/
    );
    expect(prepare).toMatch(
      /v_bubble_contract_required := v_bubble_required[\s\S]*?v_field_count > v_expected_count/
    );
    expect(prepare).toMatch(
      /INTO v_bubble_holders, v_bubble_user[\s\S]*?tp\.position = v_expected_count \+ 1/
    );
    expect(prepare).toMatch(
      /v_bubble_source := 'engine\.atomicPlaceSettlement'[\s\S]*?v_bubble_owed := v_t\.buy_in_amount/
    );
    expect(prepare).toMatch(
      /INSERT INTO public\.tournament_obligations[\s\S]*?'bubble_protection'[\s\S]*?v_bubble_user, v_bubble_owed/
    );
  });

  it('pays Bubble and every place inside the same rollback boundary before COMPLETED', () => {
    const boundary = settle.indexOf('BEGIN', settle.indexOf('BEGIN') + 1);
    const bubble = settle.indexOf("p_tournament_id, 'bubble_protection'", boundary);
    const places = settle.indexOf("o.kind = 'place'", bubble);
    const completed = settle.indexOf("SET status = 'COMPLETED'", places);
    const rollback = settle.indexOf('EXCEPTION WHEN OTHERS', completed);

    expect(boundary).toBeGreaterThan(-1);
    expect(bubble).toBeGreaterThan(boundary);
    expect(places).toBeGreaterThan(bubble);
    expect(completed).toBeGreaterThan(places);
    expect(rollback).toBeGreaterThan(completed);
  });
});
