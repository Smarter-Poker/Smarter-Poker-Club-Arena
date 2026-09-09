import { beforeEach, describe, expect, it, vi } from 'vitest';

const alerts = vi.hoisted(() => ({ raise: vi.fn(async () => ({ persisted: true })) }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: alerts.raise }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { InsuranceEngine } from './InsuranceEngine.js';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'a1000000-0000-4000-8000-000000000001';
const PLAYER = 'a1000000-0000-4000-8000-000000000002';
const OPPONENT = 'a1000000-0000-4000-8000-000000000003';

function harness(offer: Record<string, unknown>, stack: number) {
  const insurance = new InsuranceEngine(undefined, {
    start: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
  } as never);
  insurance.configure(TABLE, { enabled: true });
  (insurance as any).activeOffers.set(TABLE, [
    {
      tableId: TABLE,
      handId: `${TABLE}:1`,
      playerId: PLAYER,
      holeCards: [],
      equity: 80,
      fullPremium: 10,
      premium: 10,
      fullInsuredAmount: 100,
      insuredAmount: 100,
      coveragePercent: 100,
      atRisk: 50,
      declinedForHand: false,
      boardLength: 4,
      settlementScope: {
        kind: 'single_high_pot',
        potIndex: 0,
        eligiblePlayerIds: [PLAYER, OPPONENT],
      },
      ...offer,
    },
  ]);
  const settle = vi.spyOn(insurance, 'settle');
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = { game_type: 'cash', tournament_id: null };
  engine.insuranceEngine = insurance;
  engine.seatedPlayers = [{ user_id: PLAYER, stack }];
  engine.currentHandWinners = [];
  engine.currentHandInsuranceSettlements = [{ playerId: 'stale' }];
  engine.killForRestart = vi.fn();
  return { engine, insurance, settle };
}

describe('insurance settlement collectibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('quarantines an accepted winning contract before settlement if the full premium is unavailable', () => {
    const { engine, insurance, settle } = harness({ status: 'accepted' }, 9.99);

    expect(() => engine.settleInsuranceCashOnly([PLAYER])).toThrow(
      'Insurance settlement is not exactly collectible'
    );
    expect(settle).not.toHaveBeenCalled();
    expect(engine.currentHandInsuranceSettlements).toEqual([]);
    expect(engine.seatedPlayers[0].stack).toBe(9.99);
    expect(insurance.getOffers(TABLE)).toEqual([]);
    expect(engine.killForRestart).toHaveBeenCalledWith('insurance_settlement_not_collectible');
    expect(alerts.raise).toHaveBeenCalledWith(
      'critical',
      'ServerTableEngine.insurance_settlement_not_collectible',
      expect.any(String),
      expect.objectContaining({ premium: 10, playerId: PLAYER })
    );
  });

  it('quarantines a cashout before settlement if payout plus stack cannot fund the exact winnings redirect', () => {
    const { engine, settle } = harness(
      { status: 'cashed_out', cashoutAmount: 20, evCashoutAmount: 20 },
      79.99
    );
    engine.currentHandWinners = [{ userId: PLAYER, amount: 100 }];

    expect(() => engine.settleInsuranceCashOnly([PLAYER])).toThrow(
      'Insurance settlement is not exactly collectible'
    );
    expect(settle).not.toHaveBeenCalled();
    expect(engine.seatedPlayers[0].stack).toBe(79.99);
    expect(engine.killForRestart).toHaveBeenCalledWith('insurance_settlement_not_collectible');
  });

  it('settles when the full premium is collectible without any cap or partial debit', () => {
    const { engine, settle } = harness({ status: 'accepted' }, 10);

    const settlements = engine.settleInsuranceCashOnly([PLAYER]);

    expect(settle).toHaveBeenCalledOnce();
    expect(settlements).toEqual([
      expect.objectContaining({ playerId: PLAYER, premium: 10, payout: 0 }),
    ]);
    expect(engine.killForRestart).not.toHaveBeenCalled();
  });
});
