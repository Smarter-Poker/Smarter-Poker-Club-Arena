/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN INVITE LINK HAS TO ACTUALLY LET THE INVITED PLAYER IN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-26:
 *
 *   "when you click the link and JOIN CLUB it never allows the player to enter
 *    the club lobby"
 *
 * Two separate failures stacked on top of each other, and either one alone was
 * enough to produce exactly that.
 *
 * FAILURE ONE — THE RPC HAD NEVER RUN, NOT ONCE.
 *
 * `fn_redeem_club_invite_code` resolved the inviter with
 *
 *     player_number = p_referral_code::int
 *
 * and `profiles.player_number` is TEXT. `text = integer` has no operator in
 * Postgres, so the statement could not even be PLANNED and the function raised
 * `42883: operator does not exist: text = integer` on every call, for every
 * code shape — a UUID code included, because the planner type-checks the whole
 * OR before a single row is read. Verified against production before the fix:
 *
 *     select count(*) from profiles
 *      where ('12345' ~ '^[0-9]+$' and player_number = '12345'::int);
 *     ERROR:  42883: operator does not exist: text = integer
 *
 * `AgentService.linkPlayerByReferral` treats any error as "not an agent link"
 * and returns `{ success: false }`, so nothing surfaced. No downline was ever
 * attached, and nobody was ever admitted.
 *
 * FAILURE TWO — THE CLIENT RETURNED THE ROW FROM BEFORE THE REDEMPTION.
 *
 * `joinClub` captured the membership fn_join_club wrote, THEN redeemed the
 * code, then returned the captured copy. Every live club has
 * `requires_approval = true`, so that copy always said `status: 'pending'`.
 * Redemption is what promotes it to 'active' — but both callers
 * (InvitePage.handleJoin and ClubsPage.handleJoinClub) branch on
 * `membership.status === 'pending'` to choose between "Welcome" and the
 * approval wall. So an invited player was parked on "Request Submitted -
 * Pending Approval" while the database already had them fully active, with a
 * Browse Clubs button as the only way out.
 *
 * These tests pin the client half as behaviour. The SQL half is asserted
 * against the migration text, because CI has no database; it was proved
 * against production inside a transaction that rolled itself back, which
 * returned status=active with the inviter's upline agent attached for a
 * roll-up code and the inviter themselves for an agent's code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const linkPlayerByReferral = vi.fn();
const redeemCode = vi.fn().mockResolvedValue({ success: true });

vi.mock('../src/services/AgentService', () => ({
  AgentService: { linkPlayerByReferral: (...a: unknown[]) => linkPlayerByReferral(...a) },
  default: { linkPlayerByReferral: (...a: unknown[]) => linkPlayerByReferral(...a) },
}));

vi.mock('../src/services/ReferralService', () => ({
  referralService: { redeemCode: (...a: unknown[]) => redeemCode(...a) },
}));

const CLUB_UUID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const CLUB_SLUG = 'shark-club';
const USER = '00000000-0000-0000-0000-000000000056';
const AGENT = '171038e5-f50e-4bdd-988f-621a7ce9479c';

const pendingMembership = () =>
  ({
    club_id: CLUB_UUID,
    user_id: USER,
    role: 'player',
    status: 'pending',
    agent_id: null,
    joined_at: '2026-08-26T00:00:00Z',
  }) as never;

describe('redeemStoredInviteCode returns the membership as it stands AFTER redemption', () => {
  beforeEach(() => {
    window.localStorage.clear();
    linkPlayerByReferral.mockReset();
    redeemCode.mockClear();
  });

  it('reports the promoted status and the attached agent, not the pending row it was handed', async () => {
    // This is the regression. The caller hands in the row fn_join_club wrote
    // ('pending'); redemption promotes it; the caller must be told.
    linkPlayerByReferral.mockResolvedValue({
      success: true,
      status: 'active',
      agentId: AGENT,
      agentName: 'warden',
    });
    window.localStorage.setItem(`referral_${CLUB_UUID}`, '726343');

    const { redeemStoredInviteCode } = await import('../src/services/ClubsService');
    const after = await redeemStoredInviteCode(pendingMembership(), CLUB_UUID, CLUB_SLUG, USER);

    expect(after.status).toBe('active');
    expect(after.agent_id).toBe(AGENT);
  });

  it('clears BOTH key spellings so the code cannot re-fire on the next club joined', async () => {
    // The code is parked before the UUID is known, so callers write it under
    // whichever id they hold. Clearing only one leaves a live code behind.
    linkPlayerByReferral.mockResolvedValue({ success: true, status: 'active', agentId: AGENT });
    window.localStorage.setItem(`referral_${CLUB_UUID}`, '726343');
    window.localStorage.setItem(`referral_${CLUB_SLUG}`, '726343');

    const { redeemStoredInviteCode } = await import('../src/services/ClubsService');
    await redeemStoredInviteCode(pendingMembership(), CLUB_UUID, CLUB_SLUG, USER);

    expect(window.localStorage.getItem(`referral_${CLUB_UUID}`)).toBeNull();
    expect(window.localStorage.getItem(`referral_${CLUB_SLUG}`)).toBeNull();
  });

  it('keeps the code parked when the membership row is not visible yet', async () => {
    // 'not_a_member' is replica lag or a join still in flight, not a verdict on
    // the code. Throwing it away here strands the player on the approval wall
    // permanently, which is the failure mode this whole change exists to end.
    linkPlayerByReferral.mockResolvedValue({ success: false, code: 'not_a_member' });
    window.localStorage.setItem(`referral_${CLUB_UUID}`, '726343');

    const { redeemStoredInviteCode } = await import('../src/services/ClubsService');
    const after = await redeemStoredInviteCode(pendingMembership(), CLUB_UUID, CLUB_SLUG, USER);

    expect(window.localStorage.getItem(`referral_${CLUB_UUID}`)).toBe('726343');
    expect(after.status).toBe('pending');
  });

  it('keeps the code parked when the call throws, because that is transport, not a verdict', async () => {
    linkPlayerByReferral.mockRejectedValue(new Error('network down'));
    window.localStorage.setItem(`referral_${CLUB_UUID}`, '726343');

    const { redeemStoredInviteCode } = await import('../src/services/ClubsService');
    const after = await redeemStoredInviteCode(pendingMembership(), CLUB_UUID, CLUB_SLUG, USER);

    expect(window.localStorage.getItem(`referral_${CLUB_UUID}`)).toBe('726343');
    expect(after.status).toBe('pending');
  });

  it('falls back to the platform-wide referral code once the membership has settled', async () => {
    linkPlayerByReferral.mockResolvedValue({ success: false, code: 'unknown_inviter' });
    window.localStorage.setItem(`referral_${CLUB_UUID}`, 'ABCDEF');

    const settled = { ...(pendingMembership() as object), status: 'active' } as never;
    const { redeemStoredInviteCode } = await import('../src/services/ClubsService');
    await redeemStoredInviteCode(settled, CLUB_UUID, CLUB_SLUG, USER);

    expect(redeemCode).toHaveBeenCalledWith(USER, 'ABCDEF');
  });

  it('never spends a platform referral credit on a join an owner can still reject', async () => {
    // Pinned by the 2026-08-20 audit and still true: a platform referral credit
    // cannot be taken back, so it must not fire while the row is pending. The
    // code stays parked and can be spent once the membership settles.
    linkPlayerByReferral.mockResolvedValue({ success: false, code: 'unknown_inviter' });
    window.localStorage.setItem(`referral_${CLUB_UUID}`, 'ABCDEF');

    const { redeemStoredInviteCode } = await import('../src/services/ClubsService');
    await redeemStoredInviteCode(pendingMembership(), CLUB_UUID, CLUB_SLUG, USER);

    expect(redeemCode).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(`referral_${CLUB_UUID}`)).toBe('ABCDEF');
  });

  it('is a no-op with nothing parked, so a plain join is unaffected', async () => {
    const { redeemStoredInviteCode } = await import('../src/services/ClubsService');
    const after = await redeemStoredInviteCode(pendingMembership(), CLUB_UUID, CLUB_SLUG, USER);

    expect(linkPlayerByReferral).not.toHaveBeenCalled();
    expect(after.status).toBe('pending');
  });
});

describe('the wiring that carries that result to the screen', () => {
  const CLUBS_SERVICE = read('src/services/ClubsService.ts');
  const INVITE_PAGE = read('src/pages/InvitePage.tsx');
  const AGENT_SERVICE = read('src/services/AgentService.ts');

  it('joinClub reassigns membership from the redemption instead of returning the stale row', () => {
    // `const membership = data as ClubMember;` was the whole bug. If it comes
    // back, invite links go dead again and nothing else in this file notices.
    expect(CLUBS_SERVICE).not.toMatch(/const membership = data as ClubMember/);
    expect(CLUBS_SERVICE).toMatch(/let membership = data as ClubMember/);
    expect(CLUBS_SERVICE).toMatch(/membership = await redeemStoredInviteCode\(/);
  });

  it('InvitePage redeems for a player who arrives already pending', () => {
    // Otherwise the page is a dead end for exactly the people it is for.
    expect(INVITE_PAGE).toMatch(/ClubJoinService\.join\(/);
    expect(INVITE_PAGE).toMatch(/referralCode: refCode/);
  });

  it('InvitePage carries the slug it queried into state, so share links stay readable', () => {
    expect(INVITE_PAGE).toMatch(/slug: clubData\.slug/);
  });

  it('AgentService passes the RPC status and agent back to its caller', () => {
    expect(AGENT_SERVICE).toMatch(/status: data\.status/);
    expect(AGENT_SERVICE).toMatch(/agentId: data\.agent_id/);
    // and reports WHY a redemption failed - the silence is what hid a function
    // that had been raising on every single call since it was written.
    expect(AGENT_SERVICE).toMatch(/reason: data\?\.code/);
  });
});

describe('the share links themselves point somewhere that exists', () => {
  // Comments are stripped before matching: these assertions are about what the
  // page BUILDS, and the comments deliberately quote the dead link they
  // replaced so the next reader knows what not to put back.
  const codeOnly = (src: string) =>
    src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');

  const PROMOTIONS = codeOnly(read('src/pages/PromotionsPage.tsx'));
  const REFERRAL_MODAL = read('src/components/social/ReferralModal.tsx');

  it('the Invite and Earn modal no longer hands out a dead domain', () => {
    // It advertised `https://clubarena.poker/join?ref=<uuid>`: not the
    // production domain, and `/join` is not a route in this router. Following
    // it could not land anywhere.
    expect(PROMOTIONS).not.toMatch(/clubarena\.poker\/join/);
    expect(PROMOTIONS).toMatch(/\/hub\/club-arena\/invite\/\$\{clubId\}\?ref=\$\{referralCode\}/);
  });

  it('and no longer invents a referral code that matches no player', () => {
    // `user.id.slice(0, 8).toUpperCase()` is not anybody's code, so redemption
    // could only ever answer 'unknown_inviter'.
    expect(PROMOTIONS).not.toMatch(/slice\(0, 8\)\.toUpperCase\(\)/);
    expect(PROMOTIONS).toMatch(/select\('player_number'\)/);
  });

  it('will not report "Copied!" for a link it has not built yet', () => {
    expect(REFERRAL_MODAL).toMatch(/if \(!referralLink\) return;/);
    expect(REFERRAL_MODAL).toMatch(/disabled=\{!referralLink\}/);
  });
});

describe('the migration that made the RPC executable at all', () => {
  const MIGRATION = read('supabase/migrations/20260826_invite_redemption_never_ran.sql');

  it('never compares the text player_number to an integer again', () => {
    const body = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(body).not.toMatch(/player_number\s*=\s*p_referral_code::int\b/);
    expect(body).not.toMatch(/player_number\s*=\s*v_code::int\b/);
  });

  it('refuses to redeem on behalf of somebody else', () => {
    // It is SECURITY DEFINER and takes p_user_id from the client. Without this
    // guard any logged-in user could re-parent any member onto any agent.
    expect(MIGRATION).toMatch(/v_caller IS NOT NULL AND v_caller <> p_user_id/);
    expect(MIGRATION).toMatch(/not_your_membership/);
  });

  it('refuses a self-referral', () => {
    expect(MIGRATION).toMatch(/self_referral/);
  });

  it('never overwrites a downline that already exists', () => {
    expect(MIGRATION).toMatch(/agent_id\s*=\s*coalesce\(agent_id, v_effective_agent\)/);
  });

  it('promotes only a pending row, so a removed member cannot re-admit themselves', () => {
    expect(MIGRATION).toMatch(
      /CASE WHEN v_member\.status = 'pending' THEN 'active' ELSE v_member\.status END/
    );
    expect(MIGRATION).toMatch(/membership_blocked/);
  });
});
