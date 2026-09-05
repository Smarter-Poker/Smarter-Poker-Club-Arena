# Player Identity #SmarterCasinoRealism Audit, 2026-09-04

## Scope

Routes: `/profile`, `/profile/:userId`, `/settings`, `/notifications` (and the
Edit Profile dialog the first of them opens).

Dan: "THIS ENTIRE PAGE NEEDS A FULL AUDIT, ENHANCEMENT, IMPROVEMENT, BUG HUNT
AND OPTIMIZATION OF EVERY PAGE AND SUB PAGE ... ADD THE #SMARTERCASINOREALISM
TO EVERY PAGE AND SUB PAGE. HIT THE SETTINGS AND THE NOTIFICATIONS INSIDE HERE
AS WELL." And, mid-audit: "THERE IS NO SUCH THING AS 'PLATINUM VIP' BTW. JUST
VIP, AND LIFETIME VIP." / "THERE IS NOTHING UNLIMITED LIKE THROWABLES OR TIME
BANKS."

## What Was Wrong

Profile:

- ROI printed as `+1.6500000000000001%` in production. VPIP, PFR, 3-bet, BB/100
  and profit were raw floats; aggression and tournament win rate went through
  `toFixed`, which rounds. The gauges rounded too.
- The credential title was `profiles.username`, not the arena handle
  (`alias -> username`) every other surface resolves. Edit Profile wrote only
  `username`, so a player with an `alias` row saw the old handle after a
  "successful" save.
- A five-rung bronze/silver/gold/platinum/diamond VIP ladder was derived from
  the diamond balance, with a progress ring to the "next tier" and a benefits
  list ("Unlimited Throwables", "Auto Time Bank") the VIP page never offered.
  `profiles.tier` reads `Newcomer` on every row; VIP is `is_vip` plus
  `vip_tier` (`lifetime` | `monthly`) plus `vip_expires_at`.
- Change Avatar opened `https://smarter.poker/hub/avatars` in a new tab. The
  Edit Profile dialog offered six dicebear cartoon avatars, showed the choice,
  and persisted nothing.
- Stat chips showed fabricated zeroes while the Stats contract had not answered.
- The hero portrait was `loading="lazy"` above the fold.
- `ProfilePage.css` and `SettingsPage.css` were unreferenced dead stylesheets.

Public profile:

- Rendered `display_name`, which can hold a legal name, and the social photo,
  on an arena surface. Now the arena alias and the arena avatar.
- The QR code was fetched from `api.qrserver.com`, sending every profile URL
  to a third party. Rendered locally with `qrcode.react` (already a dependency).
- Share fired "Profile link copied!" before the clipboard promise settled.
- An "Achievement Showcase" read a field no profile ever carried.

Settings:

- Every save wrote `profiles.settings` and three push columns; nothing ever
  read them back. A second device or a cleared browser showed factory defaults
  and the next save overwrote the server copy with them.
- "Delete Account" signed the player out, cleared two caches and toasted
  "contact support". Nothing was deleted or requested. The World Hub's
  `DELETE /api/auth/delete-account` now handles it; only a confirmed success
  signs the player out.
- A signed-out export left the button on "Exporting..." forever.
- The password dialog stated a weaker rule than the handler enforced.
- No sign-out control on the security section.
- A duplicated 10-line comment and an unused `soundService` import.

Notifications:

- The placeholder portrait was `/default-avatar.png`, resolved against the
  World Hub root rather than this bundle.
- System alerts wore the hub's hooded placeholder portrait; they now carry a
  category plate.
- Empty state said "When Someone Likes, Comments, Or Tags You".
- Category badges used Instagram pink, Facebook blue and a YouTube yellow.

## Design Direction

Palette: Obsidian `#030609`, Carbon `#080d12`, Gunmetal `#26333d`, Chrome
`#dce8f0`, Steel `#b9cad7`, Broadcast Blue `#3aa8ff`, restrained brass `#d6ad52`.
Rajdhani display type, monospace eyebrows, Inter body. Light mode is the same
hardware in brushed silver, driven by tokens on each page root.

Signature: four purpose-built photoreal renders in `public/images/account/`,
1536x1024 WebP, each under 60 KB: a machined credential plate with an empty
chrome medallion (profile), a black-anodized dossier folio (public profile), a
switch-and-gauge console (settings), a brass table-call bell station
(notifications). Real application data is layered beside them in HTML.

Profile is now a credential plate: medallion portrait with a VIP / Lifetime VIP
badge, arena handle, player number, a six-cell telemetry rail (member since,
hands, VPIP, ROI, streak, table avatar) that prints a hyphen rather than a
fabricated zero, nine access plates into the dedicated workspaces, and a VIP
ledger plate that quotes `VIP_GOLD_LIMITS` so it cannot promise something
`/vip` does not.

## Changes

- `src/utils/vipStatus.ts`: the one resolver for none / vip / lifetime.
- `src/utils/aliasRules.ts`: the alias rule shared with the first-run modal.
- `ProfileService.getPublicProfile` resolves the arena name, arena avatar,
  player number and VIP status; the select carries no private aggregates.
- `UserProfileEdit`: dicebear picker removed, alias validation inline, bio
  counter, `onChangeAvatar` hands off to `AvatarGallery`.
- `AccountSurfaceHeader` accepts route-specific `artwork`.
- `CircularGauge` truncates instead of rounding.
- Notifications: day-bucket headings, visibility refresh, poker copy, own
  placeholder path, category plates for system signals.
- Settings: server hydration of `profiles.settings` and the three push columns,
  real account closure, sign out, honest copy, `finally` on export.
- Help FAQ updated to describe the closure flow that now exists.

## Real-Time Law

Presentation and read-path changes. No new channel, poll or timer. The profile
keeps its existing `PROFILE_UPDATED`, `HAND_COMPLETED`, `BALANCE_UPDATED`,
`DIAMOND_BALANCE_CHANGED` and reward bus subscriptions; notifications keeps its
single INSERT channel.

## Verification

- `npx tsc --noEmit -p tsconfig.app.json`: 0 errors.
- Targeted vitest: identity vault, dialogs, ProfileService, stats v2 boundary,
  avatar separation, arena alias law, discarded-error ratchet, page waterfalls,
  settings owners and write-scope, table studio architecture, push
  subscription, navigation laws, stylesheet integrity, bundle surface, no-hover,
  footer clearance, title-case house rule, shipped invariants: all green.
- `tests/player-identity-casino-realism.test.ts` (17) pins the fixes.
- `check-title-case`, `check-ui-text` (no em dashes), `check-painted-text-case`:
  OK.
- `vite build`: ProfilePage 48.05 kB (15.62 gzip), PublicProfilePage 32.75 kB
  (11.35 gzip), SettingsPage 30.04 kB (9.02 gzip), NotificationsPage 13.15 kB
  (4.90 gzip).
- Production cold-load proof: after publish, on the signed-in browser pane.
