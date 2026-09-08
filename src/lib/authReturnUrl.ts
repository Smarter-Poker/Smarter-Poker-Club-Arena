/**
 * Where Supabase sends a player back to from an email link (confirmation,
 * password recovery). Two rules:
 *
 *   - It is ALWAYS an https URL on the public web origin. Supabase only
 *     honours URLs on its redirect allow-list, and smarter.poker is on it.
 *     capacitor://localhost is not a place an email link can open.
 *   - On the web it is the current origin (a preview deployment keeps
 *     sending testers to itself, as ReferralDashboard already insists); in
 *     the app it is smarter.poker, and once apple-app-site-association /
 *     assetlinks.json are served there (phase 6, needs Dan's Team ID and
 *     signing certificate) that link opens the app directly and
 *     src/lib/native/deepLinks.ts finishes the sign-in. Until then it opens
 *     the web app, which handles the same link.
 */
import { publicOrigin } from './appBase';

export function authReturnUrl(inAppPath: string): string {
  const p = inAppPath.replace(/^\//, '');
  return `${publicOrigin()}/hub/club-arena/${p}`;
}
