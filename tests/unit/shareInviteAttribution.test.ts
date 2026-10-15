/**
 * Share & Invite (Dan 2026-10-15): the link is the sender's own short code,
 * a signed-out recipient is sent to Create Account first, and the code survives
 * to the join page, which claims it before joining so the sender is credited
 * and the player lands in the sender's downline.
 *
 * The database half (first-wins attribution, self-referral blocks, credit on
 * phone verification, downline placement, routing to the owner) is pinned by
 * scripts/ci/test-club-invite-attribution.sql against a disposable Postgres.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import { parseAppUrl } from '../../src/lib/native/deepLinks';
import {
  CLUB_INVITE_STORAGE_KEY,
  CLUB_INVITE_TTL_MS,
  normalizeInviteCode,
  readPendingInviteCode,
  rememberInviteCode,
  inviteShareText,
  toInAppJoinPath,
} from '../../src/services/ClubInviteService';
import { inviteSignupUrl } from '../../src/components/auth/InviteSignupRedirect';

const src = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('invite codes', () => {
  it('accepts only the 7-character database alphabet', () => {
    expect(normalizeInviteCode(' abc2345 ')).toBe('ABC2345');
    for (const bad of ['ABC234', 'ABCI234', 'ABCO234', 'ABC0234', 'ABC1234', '', null, 7]) {
      expect(normalizeInviteCode(bad)).toBeNull();
    }
  });

  it('turns only a Club Arena web path into an in-app path', () => {
    expect(toInAppJoinPath('/hub/club-arena/invite/c1?ref=9&i=ABC2345')).toBe(
      '/invite/c1?ref=9&i=ABC2345'
    );
    expect(toInAppJoinPath('https://evil.example/hub/club-arena/x')).toBeNull();
    expect(toInAppJoinPath('//evil.example')).toBeNull();
    expect(toInAppJoinPath(null)).toBeNull();
  });
});

describe('the stored invite: first link wins for 30 days', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps the first code and ignores a second', () => {
    rememberInviteCode('ABC2345', 1000);
    rememberInviteCode('XYZ6789', 2000);
    expect(readPendingInviteCode(5000)).toEqual({ code: 'ABC2345', firstSeen: 1000 });
  });

  it('expires after 30 days, and then a new link may replace it', () => {
    window.localStorage.setItem(
      CLUB_INVITE_STORAGE_KEY,
      JSON.stringify({ code: 'ABC2345', firstSeen: Date.now() - CLUB_INVITE_TTL_MS - 1 })
    );
    expect(readPendingInviteCode()).toBeNull();
    rememberInviteCode('XYZ6789');
    expect(readPendingInviteCode()?.code).toBe('XYZ6789');
  });
});

describe('a signed-out recipient goes to Create Account first', () => {
  it('carries the code, the referral number and the way back', () => {
    const url = inviteSignupUrl('/invite/c1', '?ref=300&i=ABC2345');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(url.startsWith('/auth/signup?')).toBe(true);
    expect(q.get('invite')).toBe('ABC2345');
    expect(q.get('ref')).toBe('300');
    expect(q.get('redirect')).toBe('/hub/club-arena/invite/c1?ref=300&i=ABC2345');
  });

  it('an older ?ref= link still reaches signup with its way back', () => {
    const q = new URLSearchParams(inviteSignupUrl('/invite/jaqk', '?ref=77').split('?')[1]);
    expect(q.get('invite')).toBeNull();
    expect(q.get('ref')).toBe('77');
    expect(q.get('redirect')).toBe('/hub/club-arena/invite/jaqk?ref=77');
  });

  it('the invite route renders the signup redirect instead of the login bounce', () => {
    const app = src('src/App.tsx');
    const route = app.slice(app.indexOf('path="invite/:clubId"'), app.indexOf('path="invite/:clubId"') + 200);
    expect(route).toContain('<AuthGuard publicFallback={<InviteSignupRedirect />}>');
  });
});

describe('the short link opens in the app', () => {
  it('smarter.poker/i/<CODE> and clubarena://i/<CODE> reach the in-app /i/:code route', () => {
    expect(parseAppUrl('https://smarter.poker/i/ABC2345')?.path).toBe('/i/ABC2345');
    expect(parseAppUrl('https://www.smarter.poker/i/ABC2345/')?.path).toBe('/i/ABC2345');
    expect(parseAppUrl('clubarena://i/ABC2345')?.path).toBe('/i/ABC2345');
    expect(parseAppUrl('https://smarter.poker/i/../../x')).toBeNull();
  });

  it('the route is registered', () => {
    expect(src('src/App.tsx')).toContain('<Route path="/i/:code" element={<InviteCodePage />} />');
  });
});

describe('the lobby button shares the sender’s own link', () => {
  it('opens the share sheet rather than building a ?ref= URL', () => {
    const home = src('src/pages/ClubHomePage.tsx');
    expect(home).toContain('setShowShareSheet(true)');
    expect(home).toContain('<ShareInviteSheet');
    expect(home).not.toContain('/hub/club-arena/invite/${club.id}${refQuery}');
  });

  it('the sheet uses the short link, a QR code and the sender’s stats', () => {
    const sheet = src('src/components/club/ShareInviteSheet.tsx');
    expect(sheet).toContain('getMyInviteLink(clubId)');
    expect(sheet).toContain('<QRCodeSVG value={link.shortUrl}');
    expect(sheet).toContain('getMyInviteStats(clubId)');
    expect(sheet).toContain('getClubInviteStats(clubId)');
    expect(sheet).toContain("reportError(err, 'ShareInviteSheet.link')");
  });

  it('the share text is signed with the alias', () => {
    expect(inviteShareText('KingFish', 'Club JAQK', 77777)).toBe(
      'KingFish Invited You To Join Club JAQK On Smarter.Poker!\nClub ID: 77777'
    );
  });
});

describe('the join page claims before it joins', () => {
  it('claims the short code (or the stored one) and joins with the claimed inviter', () => {
    const page = src('src/pages/InvitePage.tsx');
    expect(page).toContain("normalizeInviteCode(searchParams.get('i'))");
    expect(page).toContain('await claimInvite(');
    expect(page.indexOf('await claimInvite(')).toBeLessThan(page.indexOf(".from('club_members')"));
    expect(page).toContain('referralCode: effectiveRef');
  });

  it('a player who still owes a join is forwarded to it from the arena home', () => {
    expect(src('src/pages/HomePage.tsx')).toContain('<PendingInviteForward />');
    expect(src('src/components/home/PendingInviteForward.tsx')).toContain('getPendingClubInvite()');
  });
});
