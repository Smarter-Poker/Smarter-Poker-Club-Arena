# Share & Invite Links Credit The Sender (2026-10-15)

Dan: "THE SHARE AND INVITE LINK NEEDS TO BE HARD CODED TO THE PERSON WHO
SPECIFICALLY SENDS IT ... CREATE AN ACCOUNT FIRST, THEN AFTER THE PERSON HAS
CREATED THE ACCOUNT, VERIFIED THEIR NUMBER, IT SHOULD OPEN DIRECTLY UP TO THAT
CLUB TO JOIN ... COOKIES SHOULD BE ADDED ... THE PERSON WHO REFERRED THE USER
GETS CREDITED ... AND THEY ARE ADDED UNDER THEM IN THEIR DOWNLINES."

## What was broken

- The lobby's Share & Invite built `/invite/<club>?ref=<player number>`. A
  signed-out recipient was bounced to LOGIN, and the club was lost on the way
  through signup, email confirmation (often another device) and the phone step.
- Signup parked a referral in localStorage and the callback posted it to
  `/api/rewards/referral`, which only pays a referral a `referrals` row records.
  Nothing wrote that row, so a signup from a link was never credited.
- `fn_redeem_club_invite_code` failed the whole join when the inviter had left
  the club or been deactivated.

## What it is now

- **One short link per member per club**: `smarter.poker/i/<CODE>`
  (`club_invite_links`). The lobby button opens `ShareInviteSheet`: the link,
  Copy, Share, a QR code, and the sender's own results (opened, signed up,
  verified, joined). Owners, co-owners and admins see the whole club's invite
  stats; agents see their own downline's.
- **The World Hub `/i/[code]` page** is server-rendered with an Open Graph card
  (`/api/og/club-invite`), so messaging apps show "KingFish Invited You To Club
  JAQK" with the logo and live counts. It reads the invite server-side with the
  service role (no anonymous browser can call `fn_club_invite_resolve`; the
  inviter opening their own link is not counted). It sets the first-party attribution
  cookie (30 days, first link wins), shows Create Account first, and sends a
  signed-in player straight to the join page. Preview crawlers are not counted
  as opens.
- **The code survives every step**: cookie + localStorage (`sp-club-invite`)
  in the browser, and `club_invite_code` in the new account's metadata, which is
  the copy that crosses devices. `/auth/callback` claims it, then routes
  through `/hub/verify-phone?welcome=1&next=<join page>`; verifying (or
  skipping) continues to the club.
- **Any older invite link** (`/invite/<club>?ref=<n>`) now sends a signed-out
  visitor to signup instead of login (`InviteSignupRedirect`), with the way back
  kept in the account metadata.
- **First link wins** (`club_invite_attributions`, unique per player per club).
  The join page claims before it joins, and `fn_redeem_club_invite_code` places
  the player under the FIRST inviter whatever `ref` a later link carries.
- **Credit after phone verification**: the `profiles.phone_verified` trigger
  moves the attribution to verified, completes the `referrals` row (which the
  existing qualification reward reads) and notifies the inviter. The inviter is
  also notified on signup and on join.
- **Self-referral**: a claim from the inviter's own device, or a verification
  with the inviter's own phone number, is blocked: no credit, no placement, no
  auto-admission. The owner's beta accounts (KingFish, Danimal) are exempt
  through the existing `anti_cheat_exemptions` multi-account rows. Same network
  alone is not blocked: friends inviting each other at one home game share Wi-Fi.
- **A departed or suspended inviter** no longer fails the join: the player is
  placed directly under the club owner and waits for owner approval.
- **Arena home forwards** a player who still owes a join to that club's join
  page once per session (`PendingInviteForward`, `fn_club_invite_pending`).
- **Deep links**: `smarter.poker/i/<CODE>` and `clubarena://i/<CODE>` open the
  in-app `/i/:code` route.

## Proof

- `scripts/ci/club-invite-attribution/run.sh`: 43 scenarios against a
  disposable Postgres (fresh signup credited, first link wins, verification
  credit, downline placement under the inviter's agent, same-device and
  same-phone blocks, beta-account exemption, departed inviter routed to the
  owner, 30-day expiry, existing accounts placed but not platform-credited,
  legacy `?ref=` joins recorded, stats scoping).
- `tests/unit/shareInviteAttribution.test.ts` (client wiring) and the World Hub's
  `__tests__/club-invite-short-links.test.mjs`.

## Files

Migration `supabase/migrations/20261015181214_club_invite_links_and_attribution.sql`;
`src/services/ClubInviteService.ts`; `src/components/club/ShareInviteSheet.*`;
`src/components/auth/InviteSignupRedirect.tsx`; `src/pages/InviteCodePage.tsx`;
`src/components/home/PendingInviteForward.tsx`; `src/pages/InvitePage.tsx`;
`src/pages/ClubHomePage.tsx`; `src/App.tsx`; `src/lib/native/deepLinks.ts`.
World Hub: `pages/i/[code].js`, `pages/api/og/club-invite.js`,
`src/lib/clubInvite.js`, `pages/auth/signup.js`, `pages/auth/callback.js`,
`pages/hub/verify-phone.js`, `src/components/gates/VerificationConsole.jsx`.

## Follow-Up: The Poker Alias, Not The Login Name

The live preview for KingFish's link read "kingfish": `profiles.username` is stored lower case. Every invite surface (preview, landing page, stats, pending-join forward, inviter notifications) now prints `COALESCE(alias, username)`, the same order Club Arena uses for a player's display name. Migration `20261015223818_club_invite_names_use_the_poker_alias.sql`, applied to production as `20261015224105`, function bodies only, all six verified md5-identical to the file. Scenario added to `scripts/ci/club-invite-attribution` (44 pass).

## Follow-Up: Audit Fixes

- `fn_club_invite_club_stats` now admits staff and agents whose membership status is `automatic`, matching every other invite function (`20261016004124_club_invite_stats_admit_automatic_members.sql`, applied as `20261016004204`, md5-verified).
- The Share & Invite sheet clears the previous club's link, QR, figures and stats when the club changes, so a failed load can never show or copy another club's link.

## Follow-Up: The Sheet Clears The Header And Footer

Checked live after publish at 1024x768: the sheet rendered inside the club page's `z-index: 1` stacking context, so the sticky header covered its close control and the fixed footer covered Share and Close (a tap on Close opened the Market). The sheet now renders through `createPortal` to `document.body`, where its overlay (`z-index: 10000`, scrollable) clears both. Proven on the live page by re-parenting the overlay: all five controls became reachable.

## Second Audit (2026-10-16)

Database (`20261016040136_club_invite_deep_sweep_hardening.sql`, applied as `20261016040608`, md5-verified; 54 harness scenarios):
- A client-reported first click can no longer predate the link, and a fresh signup must postdate the link, so no account can steer platform referral credit to an inviter of its choice.
- Concurrent claims cannot split attribution and referral between two inviters (the insert returns its id; the loser answers with the winner's row).
- Unjoined attributions lapse after 30 days in claim and redeem, not only in the pending forward.
- A self-referral block binds only the inviter it was raised against.
- A joining member with status `automatic` is placed like any member.
- Re-running an invite for a settled member records no join and sends no notification.
- Only the landing page's server request counts an open.
- Any membership row ends the pending forward, so a refused member is never sent back.

Proven end to end on the production schema in one self-aborting transaction: claim, phone verification through the service context, `fn_join_club_atomic` with the referral, placement, attribution `joined`, two inviter notifications, and a no-op re-run.

Client:
- The pending forward asks the database once per session even when nothing is pending.
- No Share & Invite in the automatic Diamond Arena (no membership row, no downline).
- The app build opens the system share sheet (Capacitor Share); the web keeps navigator.share and copy.
- Agent invite modal (when the agent opens it), Club Settings and Promotions share the sender's short link, falling back to the old link.
- A signed-out invite in the app opens Create Account, and the in-app signup carries the invite into the account metadata.

## Final Audit (2026-10-16)

- `20261016042212_club_invite_notify_actor_and_first_redemption.sql` (applied as `20261016042426`, md5-verified, 58 harness scenarios): invite notifications carry the invited player as `actor_id` (avatar in the feed, collapsed push tag); `club_invite_signup` is a bell row only, so unverified throwaway accounts cannot buzz an inviter's phone; the first redemption of a join in progress is recorded again even when the member stays pending under the owner. Re-proven end to end on the production schema (rolled back): verified and joined notices push with the actor set.
- The arena-home forward spends its once-per-session slot only on a real answer, so a failed read retries next visit; the key is shared with the World Hub forwarder on the same origin.
- Promotions shares the short link even before the player number loads.
- World Hub: redirect targets refuse control characters (a tab turned `/<TAB>/evil.com` into `//evil.com`), any explained claim refusal stops the join-path fallback, verify-phone follows a pending invite that loads late.
