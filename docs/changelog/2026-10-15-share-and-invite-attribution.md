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
  JAQK" with the logo and live counts. It sets the first-party attribution
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

- `scripts/ci/club-invite-attribution/run.sh`: 41 scenarios against a
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
