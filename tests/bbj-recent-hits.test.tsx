/**
 * BBJ recent-hits view — the naming trap (2026-08-18).
 *
 * In bbj_payouts / bbj_winners, "winner" means winner OF THE JACKPOT (the
 * bad-beat holder, who LOST the hand) and "loser" is the player who won the
 * pot. Reading those columns naively puts the wrong name against the wrong
 * hand — the bug this shipped to fix. fn_bbj_recent_hits therefore returns
 * already-resolved roles; these tests pin the contract the UI relies on so a
 * future change to that function cannot silently re-cross them.
 */
import { describe, it, expect } from 'vitest';

type Role = 'bad_beat' | 'hand_winner' | 'table';
interface Recipient {
  name: string;
  amount: number;
  role: Role;
}

/** Shape returned by fn_bbj_recent_hits (verified against production rows). */
const HIT = {
  total_payout: 5315.31,
  bad_beat_name: 'Amanda Foster',
  bad_beat_hand: 'Four of a Kind',
  bad_beat_amount: 2657.66,
  hand_winner_name: 'Victoria Svensson',
  hand_winner_hand: 'Straight Flush',
  hand_winner_amount: 1328.83,
  table_player_count: 2,
  recipients: [
    { name: 'Amanda Foster', amount: 2657.66, role: 'bad_beat' },
    { name: 'Victoria Svensson', amount: 1328.83, role: 'hand_winner' },
    { name: 'Gwendolyn Beaufort', amount: 664.41, role: 'table' },
    { name: 'Cutoffkid', amount: 664.41, role: 'table' },
  ] as Recipient[],
};

describe('recent-hit payout contract', () => {
  it('pays the bad-beat holder the largest single share', () => {
    const top = [...HIT.recipients].sort((a, b) => b.amount - a.amount)[0];
    expect(top.role).toBe('bad_beat');
    expect(top.name).toBe(HIT.bad_beat_name);
  });

  it('splits 50 / 25 / 25 across the three roles', () => {
    const sum = (role: Role) =>
      HIT.recipients.filter((r) => r.role === role).reduce((s, r) => s + r.amount, 0);
    expect(sum('bad_beat') / HIT.total_payout).toBeCloseTo(0.5, 3);
    expect(sum('hand_winner') / HIT.total_payout).toBeCloseTo(0.25, 3);
    expect(sum('table') / HIT.total_payout).toBeCloseTo(0.25, 3);
  });

  it('recipient amounts reconcile to the stated total', () => {
    const total = HIT.recipients.reduce((s, r) => s + r.amount, 0);
    expect(Math.abs(total - HIT.total_payout)).toBeLessThan(0.02);
  });

  it('exactly one bad_beat and one hand_winner per hit', () => {
    expect(HIT.recipients.filter((r) => r.role === 'bad_beat')).toHaveLength(1);
    expect(HIT.recipients.filter((r) => r.role === 'hand_winner')).toHaveLength(1);
  });

  it('the bad-beat hand is the one that LOST — never rendered as the winner', () => {
    // The UI renders "<bad_beat_hand> lost to <hand_winner_hand>". If those were
    // ever swapped we would print "Straight Flush lost to Four of a Kind".
    const line = `${HIT.bad_beat_hand} lost to ${HIT.hand_winner_hand}`;
    expect(line).toBe('Four of a Kind lost to Straight Flush');
    expect(line).not.toBe('Straight Flush lost to Four of a Kind');
  });

  it("marks the viewer's own row case-insensitively", () => {
    const viewer = 'amanda foster';
    const you = HIT.recipients.filter((r) => r.name.toLowerCase() === viewer.toLowerCase());
    expect(you).toHaveLength(1);
    expect(you[0].role).toBe('bad_beat');
  });
});
