import { describe, expect, it } from 'vitest';
import { deriveContext } from './TournamentBrainContext.js';
import { validHorseTournamentPayoutTerms } from '../engine/HorseTournamentPayoutTerms.js';
import {
  buildHorseDecisionKey,
  validatedHorsePolicySamplingKey,
} from '../engine/horseDecision/protocol.js';
import { reconstructHorseReplayInput } from '../engine/horseDecision/replay/reconstruct.js';
import {
  phase6cFixtureRecord,
  PHASE6C_FIXTURE_IDS,
  resignHorseJournalRecord,
} from '../engine/horseDecision/replay/fixtures/index.js';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  format_contract: 'spin-v1',
  tournament_type: 'SPIN',
  game_type: 'NLH',
  variant: 'spin',
  spin_multiplier: 2,
  status: 'RUNNING',
  max_players: 3,
  table_size: 3,
  prize_pool: 60,
  bounty_pool: 0,
  prize_pool_finalized: true,
  bubble_protection: false,
  buy_in_amount: 10,
  payout_club: { asset: 'chips', is_platform: false, union_id: null },
  ...over,
});
const context = (over: Record<string, unknown> = {}) =>
  deriveContext(row(over) as never, 3, 2, 3000);

describe('original tournament payout capture', () => {
  it('captures actual finalization, denomination and canonical funded WTA ladder', () => {
    expect(context()).toMatchObject({
      payoutTermsVersion: 1,
      prizePoolFinalized: true,
      bubbleProtection: false,
      prizeUnitCents: 1,
      finalizedPrizeLadder: {
        version: 'horse-finalized-prize-ladder-v1',
        finalized: true,
        tournamentId: 'event-1',
        source: 'tournaments+clubs/canonical-payout-v1',
        poolCents: 6000,
        unitCents: 1,
        prizesCents: [6000],
        bubbleProtection: false,
        bubbleReserveCents: 0,
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
  it.each([false, null, undefined])(
    'does not infer finalized true from closed entry: %s',
    (value) => {
      const captured = context({ prize_pool_finalized: value }) as any;
      expect(captured.prizePoolFinalized).toBe(value === undefined ? null : value);
      expect(captured.finalizedPrizeLadder).toBeUndefined();
    }
  );
  it('keeps an unread denomination or Bubble Promise unknown', () => {
    expect(context({ payout_club: undefined })).toMatchObject({ prizeUnitCents: null });
    expect((context({ payout_club: undefined }) as any).finalizedPrizeLadder).toBeUndefined();
    expect(context({ bubble_protection: undefined })).toMatchObject({ bubbleProtection: null });
    expect((context({ bubble_protection: undefined }) as any).finalizedPrizeLadder).toBeUndefined();
  });
  it('captures the same pool-funded Bubble Promise reserve as settlement', () => {
    expect((context({ bubble_protection: true }) as any).finalizedPrizeLadder).toMatchObject({
      poolCents: 6000,
      prizesCents: [5000],
      bubbleProtection: true,
      bubbleReserveCents: 1000,
    });
  });
  it('reads the actual Diamond denomination and detaches captured terms', () => {
    const original = row({ payout_club: { asset: 'diamonds', is_platform: true, union_id: null } });
    const captured = deriveContext(original as never, 3, 2, 3000) as any;
    expect(captured.prizeUnitCents).toBe(100);
    original.payout_club.asset = 'chips';
    expect(captured.finalizedPrizeLadder.unitCents).toBe(100);
  });
  it('validates captured terms without rewriting or fabricating legacy fields', () => {
    expect(validHorseTournamentPayoutTerms({})).toBe(true);
    const captured = { ...context(), tournamentId: 'event-1' };
    expect(validHorseTournamentPayoutTerms(captured)).toBe(true);
    expect(validHorseTournamentPayoutTerms({ prizePoolFinalized: true })).toBe(false);
    for (const change of [
      { payoutTermsVersion: 2 },
      { prizePoolFinalized: null },
      { prizeUnitCents: null },
      { tournamentId: 'wrong' },
      { finalizedPrizeLadder: { ...captured.finalizedPrizeLadder!, prizesCents: [5900] } },
      { finalizedPrizeLadder: { ...captured.finalizedPrizeLadder!, sourceDigest: 'f'.repeat(64) } },
    ])
      expect(validHorseTournamentPayoutTerms({ ...captured, ...change } as any)).toBe(false);
  });
  it('binds all original capture fields in the input digest without perturbing policy sampling', () => {
    const request: any = {
      fence: 'turn',
      decisionTimeMs: 1234,
      player: {},
      gameState: { tournament: { tournamentId: 'event-1' } },
    };
    const priorKey = buildHorseDecisionKey(request);
    const captured: any = context();
    const keys = [
      'payoutTermsVersion',
      'prizePoolFinalized',
      'bubbleProtection',
      'prizeUnitCents',
      'finalizedPrizeLadder',
    ];
    const fields = Object.fromEntries(keys.map((key) => [key, captured[key]]));
    request.gameState.tournament = { ...request.gameState.tournament, ...fields };
    request.decisionKey = buildHorseDecisionKey(request);
    expect(request.decisionKey).not.toBe(priorKey);
    expect(validatedHorsePolicySamplingKey(request)).toBe(priorKey);
    for (const key of keys) {
      const changed = structuredClone(request);
      delete changed.gameState.tournament[key];
      expect(buildHorseDecisionKey(changed)).not.toBe(request.decisionKey);
    }
  });
  it('preserves original capture through private FAST journal replay and rejects a present corrupt version', () => {
    const original = phase6cFixtureRecord(PHASE6C_FIXTURE_IDS.tournamentFlop);
    const captured = context() as any;
    const record = resignHorseJournalRecord(original, (body) => {
      const request = body.snapshot as any;
      const id = request.gameState.tournament.tournamentId;
      const actual = deriveContext(row({ id }) as never, 3, 2, 3000) as any;
      for (const key of [
        'payoutTermsVersion',
        'prizePoolFinalized',
        'bubbleProtection',
        'prizeUnitCents',
        'finalizedPrizeLadder',
      ]) {
        request.gameState.tournament[key] = actual[key];
      }
      request.decisionKey = buildHorseDecisionKey(request);
    });
    const replay = reconstructHorseReplayInput(record);
    expect(replay.request.gameState.tournament?.finalizedPrizeLadder?.prizesCents).toEqual([6000]);
    const corrupt = resignHorseJournalRecord(record, (body) => {
      (body.snapshot as any).gameState.tournament.payoutTermsVersion = 2;
    });
    expect(() => reconstructHorseReplayInput(corrupt)).toThrow(
      'replay_input_incomplete:payout_terms'
    );
    expect(captured.prizePoolFinalized).toBe(true);
  });
});
