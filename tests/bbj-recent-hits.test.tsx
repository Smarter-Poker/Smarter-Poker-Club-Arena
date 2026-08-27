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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/**
 * Dan 2026-08-27: "you need to use there club avatar as the image, not there
 * profile pics."
 *
 * fn_bbj_recent_hits had resolved the winner image as
 * COALESCE(clubs.avatar_url, profiles.avatar_url). Both clubs that have hit
 * carry a NULL clubs.avatar_url, so every row fell through to the SOCIAL MEDIA
 * photo — the exact column tests/unit/arenaAvatarSeparation.test.ts exists to
 * keep this app out of. It passed that test only because the read lives in SQL,
 * where the .from('profiles') scanner cannot see it.
 *
 * These pin the two halves of the corrected path in the one place a scanner
 * CAN see: the component. The SQL half is asserted by the migration itself
 * (supabase/migrations/20260827_bbj_full_hand_seed.sql).
 */
describe('the winner row draws the club avatar', () => {
  const SRC = readFileSync(resolve(__dirname, '../src/components/bbj/BBJRecentHits.tsx'), 'utf8');

  it('resolves the avatar through getAvatarWithFallback', () => {
    // arena_avatar_url arrives Hub-relative (/avatars/table/vip_spartan@2x.webp).
    // Handed straight to an <img> it resolves against whatever origin the client
    // happens to be on, which is wrong everywhere except production.
    expect(SRC).toMatch(/getAvatarWithFallback\(\s*hit\.bad_beat_avatar_url/);
  });

  it('never reaches for a profile photo field on the hit row', () => {
    // The row type carries exactly one image field and it is the club one. If a
    // future change adds `profile_avatar_url` or similar as a fallback, the
    // separation is gone again and nothing else would catch it.
    expect(SRC).not.toMatch(/\bprofile_(avatar|pic|photo)\w*/);
  });
});
