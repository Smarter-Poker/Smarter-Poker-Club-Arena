import { describe, expect, it } from 'vitest';
import { evaluateSit, JAQK_CLUB_ID, MIDWAY_UNION_ID, type SitRequest } from './StableHand.js';

const request = (over: Partial<SitRequest> = {}): SitRequest => ({
  activeClubId: null,
  activeHostId: null,
  activeSeatCount: 1,
  maxTables: 1,
  clubId: JAQK_CLUB_ID,
  tableHostId: MIDWAY_UNION_ID,
  bb: 2,
  available: 100_000,
  sessionStartBalance: 100_000,
  currentCommit: 200,
  buyIn: 200,
  persona: 'regular',
  sitsOnKeyToday: 99,
  isRestDay: true,
  inTwoHourWindow: true,
  killed: false,
  bankrollOnly: true,
  ...over,
});

describe('the cash fifty are eligible by bankroll', () => {
  it('ignores persona ceilings, rest days, daily sits and texture rejoin windows', () => {
    expect(evaluateSit(request())).toBe('ok');
  });
  it('retains bankroll, exposure, wallet ownership and universal seat safeguards', () => {
    expect(evaluateSit(request({ available: 0 }))).toBe('brm');
    expect(evaluateSit(request({ currentCommit: 60_000 }))).toBe('brm');
    expect(evaluateSit(request({ activeSeatCount: 4 }))).toBe('seat_cap');
    expect(evaluateSit(request({ activeClubId: 'another-club' }))).toBe('other_club');
    expect(evaluateSit(request({ killed: true }))).toBe('killed');
  });
  it('leaves non-roster behavior unchanged', () => {
    expect(evaluateSit(request({ bankrollOnly: false }))).toBe('seat_cap');
  });
});
