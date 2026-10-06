import { describe, expect, it } from 'vitest';
import { parseClubBombPotReport } from '../../src/pages/club/ClubBombPotReportPage';
import { parseClubInsuranceReport } from '../../src/pages/club/ClubInsuranceReportPage';

const CLUB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
  contract: 'ca_club_insurance_report.v2',
  contract_version: 2,
  club_id: CLUB_ID,
  requested_days: 7,
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
    const envelope = {
      contract: 'fn_club_bomb_pot_report.v2',
      contract_version: 2,
      club_id: CLUB_ID,
      requested_days: 7,
      window_days: 7,
      window_start: '2026-09-30',
      window_end: '2026-10-07',
      generated_at: '2026-10-07T12:00:00.000Z',
      rows: [bombRow],
    };
    expect(parseClubBombPotReport(envelope, CLUB_ID, 7)).toEqual([bombRow]);
    expect(parseClubBombPotReport({ ...envelope, rows: [] }, CLUB_ID, 7)).toEqual([]);
    expect(() => parseClubBombPotReport([bombRow], CLUB_ID, 7)).toThrow('response is invalid');
    expect(() =>
      parseClubBombPotReport({ ...envelope, club_id: bombRow.table_id }, CLUB_ID, 7)
    ).toThrow('scope receipt is invalid');
    expect(() =>
      parseClubBombPotReport(
        { ...envelope, rows: [{ ...bombRow, unrecorded_hands: 0 }] },
        CLUB_ID,
        7
      )
    ).toThrow('outcomes do not reconcile');
    expect(() =>
      parseClubBombPotReport({ ...envelope, rows: [bombRow, bombRow] }, CLUB_ID, 7)
    ).toThrow('duplicated');
  });

  it('binds insurance reports to the requested window and exact ledger arithmetic', () => {
    expect(parseClubInsuranceReport(insuranceReport, CLUB_ID, 7)).toMatchObject({
      window_days: 7,
      money: { bank_net: 4 },
      totals: { take_rate_pct: 66.7 },
    });
    expect(() => parseClubInsuranceReport(insuranceReport, CLUB_ID, 30)).toThrow(
      'scope receipt is invalid'
    );
    expect(() =>
      parseClubInsuranceReport({ ...insuranceReport, club_id: bombRow.table_id }, CLUB_ID, 7)
    ).toThrow('scope receipt is invalid');
    expect(() =>
      parseClubInsuranceReport(
        { ...insuranceReport, money: { ...insuranceReport.money, bank_net: 5 } },
        CLUB_ID,
        7
      )
    ).toThrow('money does not reconcile');
    expect(() =>
      parseClubInsuranceReport(
        {
          ...insuranceReport,
          days: [{ ...insuranceReport.days[0], bank_net: 7 }, insuranceReport.days[1]],
        },
        CLUB_ID,
        7
      )
    ).toThrow('daily money does not reconcile');
  });

  it('accepts only a scoped zero-row insurance receipt', () => {
    const empty = {
      ...insuranceReport,
      totals: {
        offers: 0,
        accepted: 0,
        declined: 0,
        timeouts: 0,
        cashouts: 0,
        take_rate_pct: null,
        avg_offer_equity: null,
        avg_offer_pot: null,
      },
      money: {
        contracts: 0,
        insurance_contracts: 0,
        cashout_contracts: 0,
        bank_in: 0,
        bank_out: 0,
        bank_net: 0,
      },
      days: [],
    };
    expect(parseClubInsuranceReport(empty, CLUB_ID, 7).days).toEqual([]);
    expect(() => parseClubInsuranceReport({ ...empty, contract: 'legacy' }, CLUB_ID, 7)).toThrow(
      'scope receipt is invalid'
    );
  });
});
