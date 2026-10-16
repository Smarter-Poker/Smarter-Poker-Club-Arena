/**
 * A signed-out visitor on a club invite goes to CREATE AN ACCOUNT, not login.
 *
 * Dan 2026-10-15: "IF ITS SENT TO A USER IT NEEDS TO BE CLICKABLE TO OPEN UP TO
 * 'CREATE AN ACCOUNT' FIRST, THEN AFTER THE PERSON HAS CREATED THE ACCOUNT,
 * VERIFIED THEIR NUMBER, IT SHOULD OPEN DIRECTLY UP TO THAT CLUB TO JOIN."
 *
 * Rendered by AuthGuard's publicFallback on /invite/:clubId and on the
 * short-link route /i/:code, so it covers every invite link ever shared,
 * including the older /invite/<club>?ref=<n> form that predates the short
 * /i/<CODE> links. On the web it hands off to the
 * World Hub signup with the referral number, the invite code (when the link
 * carries one) and the way back to this exact page. Inside the native app
 * there is no World Hub signup page, so it opens the in-app AuthPage on its
 * Create Account form (mode=signup), which returns here the same way.
 */
import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { IS_NATIVE_BUILD } from '../../lib/appBase';
import { signInUrl, toWebPath } from '../../lib/signIn';
import { rememberInviteCode, normalizeInviteCode } from '../../services/ClubInviteService';
import PageSkeleton from '../common/PageSkeleton';

/**
 * Pure: the invite code a page carries, from `?i=<CODE>` on /invite/:clubId or
 * from the path itself on the short-link route /i/<CODE>.
 */
export function inviteCodeFromLocation(pathname: string, search: string): string | null {
  const fromQuery = normalizeInviteCode(new URLSearchParams(search).get('i'));
  if (fromQuery) return fromQuery;
  const m = /^(?:\/hub\/club-arena)?\/i\/([^/?#]+)\/?$/.exec(pathname);
  return m ? normalizeInviteCode(m[1]) : null;
}

/** Pure: the World Hub signup URL for an invite page path + search. */
export function inviteSignupUrl(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  const code = inviteCodeFromLocation(pathname, search);
  const ref = (params.get('ref') || '').trim();
  if (code) out.set('invite', code);
  if (/^[0-9]{1,12}$/.test(ref)) out.set('ref', ref);
  out.set('redirect', toWebPath(`${pathname}${search}`));
  return `/auth/signup?${out.toString()}`;
}

export default function InviteSignupRedirect() {
  const location = useLocation();

  useEffect(() => {
    const code = inviteCodeFromLocation(location.pathname, location.search);
    if (code) rememberInviteCode(code);
    if (IS_NATIVE_BUILD) return;
    // The World Hub signup is outside this app's router: a full navigation.
    window.location.replace(inviteSignupUrl(location.pathname, location.search));
  }, [location.pathname, location.search]);

  if (IS_NATIVE_BUILD) {
    // No World Hub in the bundle: the in-app AuthPage, routed in the SPA, on
    // its Create Account form (an invite is for someone without an account).
    return (
      <Navigate
        to={signInUrl(`${location.pathname}${location.search}`, { signup: true })}
        replace
      />
    );
  }
  return <PageSkeleton variant="default" />;
}
