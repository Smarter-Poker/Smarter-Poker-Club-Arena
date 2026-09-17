import { describe, expect, it } from 'vitest';
import {
  assertDiamondCashSettingsOpen,
  DiamondCashPolicyClosedError,
} from './cashTablePlayEligibility.js';

const TABLE = '42dbb91d-42b5-4b6d-af41-86b08203b9cd';
const ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';

describe('Diamond cash policy evidence', () => {
  it('classifies only an error-free explicit false bound to this arena as policy closed', () => {
    expect(() =>
      assertDiamondCashSettingsOpen(
        TABLE,
        ARENA,
        { club_id: ARENA, cash_games_enabled: true },
        null
      )
    ).not.toThrow();
    try {
      assertDiamondCashSettingsOpen(
        TABLE,
        ARENA,
        { club_id: ARENA, cash_games_enabled: false },
        null
      );
      throw new Error('missing refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DiamondCashPolicyClosedError);
      expect(error).toMatchObject({
        code: 'diamond_cash_disabled',
        tableId: TABLE,
        arenaId: ARENA,
      });
    }
  });

  it.each(
    [
      null,
      undefined,
      [],
      [{ club_id: ARENA, cash_games_enabled: false }],
      { club_id: 'other-arena', cash_games_enabled: false },
      { club_id: ARENA },
      { club_id: ARENA, cash_games_enabled: null },
      { club_id: ARENA, cash_games_enabled: 'false' },
      { club_id: ARENA, cash_games_enabled: 0 },
    ].map((data) => ({ data }))
  )('keeps missing, malformed or incorrectly bound data actionable: %j', ({ data }) => {
    expect(() => assertDiamondCashSettingsOpen(TABLE, ARENA, data, null)).toThrow(
      /unavailable|malformed/
    );
    try {
      assertDiamondCashSettingsOpen(TABLE, ARENA, data, null);
    } catch (error) {
      expect(error).not.toBeInstanceOf(DiamondCashPolicyClosedError);
    }
  });

  it.each([false, true])('a read failure is unknown even when the body says %s', (enabled) => {
    const cause = new Error('supabase_timeout');
    try {
      assertDiamondCashSettingsOpen(
        TABLE,
        ARENA,
        { club_id: ARENA, cash_games_enabled: enabled },
        cause
      );
      throw new Error('missing failure');
    } catch (error) {
      expect(error).not.toBeInstanceOf(DiamondCashPolicyClosedError);
      expect(error).toMatchObject({
        message: 'Diamond cash settings read failed: supabase_timeout',
        cause,
      });
    }
  });

  it('does not classify a matching free-text message as an authoritative refusal', () => {
    expect(new Error('Diamond Cash Games Are Not Open')).not.toBeInstanceOf(
      DiamondCashPolicyClosedError
    );
  });

  it('requires an explicit successful read result rather than an absent error field', () => {
    expect(() =>
      assertDiamondCashSettingsOpen(
        TABLE,
        ARENA,
        { club_id: ARENA, cash_games_enabled: false },
        undefined
      )
    ).toThrow('Diamond cash settings read failed');
  });
});
