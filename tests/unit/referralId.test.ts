/**
 * Dan (KingFish, player 1), 2026-10-16: "change my referral ID from 1 to
 * KingFish, im the only one that should have there reference ID as a name,
 * everyone else uses player number."
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isNamedReferralId,
  playerNumberForReferralId,
  referralIdFor,
} from '../../src/lib/referralId';

describe('referral IDs', () => {
  it('player 1 is KingFish, whether the number arrives as text or a number', () => {
    expect(referralIdFor('1')).toBe('KingFish');
    expect(referralIdFor(1)).toBe('KingFish');
    expect(referralIdFor(' 1 ')).toBe('KingFish');
  });

  it('everyone else keeps their player number', () => {
    expect(referralIdFor('2')).toBe('2');
    expect(referralIdFor(25450)).toBe('25450');
    expect(referralIdFor('983806')).toBe('983806');
    expect(referralIdFor('10')).toBe('10');
    expect(referralIdFor(null)).toBeNull();
    expect(referralIdFor(undefined)).toBeNull();
    expect(referralIdFor('')).toBeNull();
  });

  it('KingFish comes back to player 1 in any case; numbers pass through', () => {
    expect(playerNumberForReferralId('KingFish')).toBe('1');
    expect(playerNumberForReferralId('kingfish')).toBe('1');
    expect(playerNumberForReferralId(' KINGFISH ')).toBe('1');
    expect(playerNumberForReferralId('726343')).toBe('726343');
    expect(playerNumberForReferralId('1')).toBe('1');
  });

  it('only KingFish is a named referral ID', () => {
    expect(isNamedReferralId('KingFish')).toBe(true);
    expect(isNamedReferralId('1')).toBe(false);
    expect(isNamedReferralId('Danimal')).toBe(false);
    expect(isNamedReferralId(null)).toBe(false);
  });

  it('the database door maps the same name to the same player', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../supabase/migrations/20261016232523_kingfish_referral_id_resolves_to_player_one.sql'
      ),
      'utf8'
    );
    expect(sql).toContain("IF lower(v_code) = 'kingfish' THEN");
    expect(sql).toContain("v_code := '1';");
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_redeem_club_invite_code(p_club_id uuid, p_user_id uuid, p_referral_code text)'
    );
  });
});
