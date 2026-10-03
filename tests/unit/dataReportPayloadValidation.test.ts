import { describe, expect, it } from 'vitest';
import { parseClubBombPotReport } from '../../src/pages/club/ClubBombPotReportPage';
import { parseClubInsuranceReport } from '../../src/pages/club/ClubInsuranceReportPage';

const bombRow = {
  table_id: '11111111-1111-4111-8111-111111111111',
  table_name: 'Bomb Room',
  trigger_reason: 'once_per_orbit',
  board_count: 2,
  variant: 'double_board_holdem',
  hands: 3,
  avg_players: 5.5,
  avg_pot: 120.25,
  total_pot: 360.75,
  total_rake: 10.5,
  total_antes: 30,
  scoops: 1,
  splits: 1,
  unrecorded_hands: 1,
};

const insuranceReport = {
  window_days: 7,
  window_start: '2026-10-01',
  window_end: '2026-10-07',
  bank: 'union',
  totals: {
    offers: 3,
    accepted: 1,
    declined: 1,
    timeouts: 0,
    cashouts: 1,
    take_rate_pct: 66.7,
    avg_offer_equity: 50,
    avg_offer_pot: 100,
  },
  money: {
    contracts: 2,
    insurance_contracts: 1,
    cashout_contracts: 1,
    bank_in: 13,
    bank_out: 9,
    bank_net: 4,
  },
  days: [
    {
      day: '2026-10-07',
      offers: 2,
      accepted: 1,
      declined: 1,
      timeouts: 0,
      cashouts: 0,
      contracts: 1,
      bank_in: 10,
      bank_out: 4,
      bank_net: 6,
    },
    {
      day: '2026-10-06',
      offers: 1,
      accepted: 0,
      declined: 0,
      timeouts: 0,
      cashouts: 1,
      contracts: 1,
      bank_in: 3,
      bank_out: 5,
      bank_net: -2,
    },
  ],
  generated_at: '2026-10-07T12:00:00.000Z',
};

describe('Club Data report payload validation', () => {
  it('accepts a reconciled bomb-pot report and refuses malformed or contradictory rows', () => {
    expect(parseClubBombPotReport([bombRow])).toEqual([bombRow]);
    expect(() => parseClubBombPotReport({ rows: [bombRow] })).toThrow('response is invalid');
    expect(() => parseClubBombPotReport([{ ...bombRow, unrecorded_hands: 0 }])).toThrow(
      'outcomes do not reconcile'
    );
    expect(() => parseClubBombPotReport([bombRow, bombRow])).toThrow('duplicated');
  });

  it('binds insurance reports to the requested window and exact ledger arithmetic', () => {
    expect(parseClubInsuranceReport(insuranceReport, 7)).toMatchObject({
      window_days: 7,
      money: { bank_net: 4 },
      totals: { take_rate_pct: 66.7 },
    });
    expect(() => parseClubInsuranceReport(insuranceReport, 30)).toThrow('window is invalid');
    expect(() =>
      parseClubInsuranceReport(
        { ...insuranceReport, money: { ...insuranceReport.money, bank_net: 5 } },
        7
      )
    ).toThrow('money does not reconcile');
    expect(() =>
      parseClubInsuranceReport(
        {
          ...insuranceReport,
          days: [{ ...insuranceReport.days[0], bank_net: 7 }, insuranceReport.days[1]],
        },
        7
      )
    ).toThrow('daily money does not reconcile');
  });
});
