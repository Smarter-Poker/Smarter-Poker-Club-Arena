/**
 * The Anti-Cheat Flags tab printed each flag's `reason` as raw JSON, cut off
 * mid-key. describeFlagReason turns every shape the detectors write into a
 * sentence a reviewer can act on, and hands back the other accounts so the
 * row can link to them (2026-10-22).
 */
import { describe, expect, it } from 'vitest';

import { describeFlagReason } from '../../src/utils/antiCheatFlagReason';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('describeFlagReason', () => {
  it('reads a v3 same-device, same-hands flag', () => {
    const v = describeFlagReason(
      JSON.stringify({
        detector: 'multi_account_v3',
        evidence: ['same_device', 'same_hands'],
        other_user_ids: [A],
        shared_hands: 14,
        hand_numbers: [1001, 1002],
      })
    );
    expect(v.summary).toBe('Same Device · 14 Hands Played Together');
    expect(v.otherIds).toEqual([A]);
    expect(v.handNumbers).toEqual([1001, 1002]);
  });

  it('reads a v3 two-address flag', () => {
    const v = describeFlagReason(
      JSON.stringify({
        detector: 'multi_account_v3',
        evidence: ['shared_household_ips'],
        other_user_ids: [B],
        shared_ips: 3,
      })
    );
    expect(v.summary).toBe('3 Shared Home Addresses');
    expect(v.otherIds).toEqual([B]);
  });

  it('reads a v2 same-table flag', () => {
    const v = describeFlagReason(
      JSON.stringify({ detector: 'multi_account_v2', evidence: 'same_table_same_ip', other_user_ids: [A] })
    );
    expect(v.summary).toBe('Same Table From The Same Address');
  });

  it('labels the retired v1 check as retired', () => {
    const v = describeFlagReason(
      JSON.stringify({ detector: 'multi_account_ip_match_v1', account_count: 3, other_user_ids: [A, B] })
    );
    expect(v.summary).toBe('Same IP Address As 2 Other Accounts (Retired Check)');
    expect(v.otherIds).toEqual([A, B]);
  });

  it('never prints raw JSON and passes plain sentences through', () => {
    expect(describeFlagReason('Owner beta testing').summary).toBe('Owner beta testing');
    expect(describeFlagReason(null).summary).toBe('No Reason Recorded');
    expect(describeFlagReason('{"detector":"chip_dump_v1"}').summary).not.toContain('{');
  });
});
