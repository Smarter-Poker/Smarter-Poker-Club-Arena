# Profile + Public Profile: Full Audit And #smarterCasinoRealism Rebuild (2026-09-04)

## Scope

Routes: `/profile` (own credential, four panels: Snapshot, Distinctions,
Activity, Network), `/profile/:userId` (another player's dossier), and the
Edit Profile dialog. Dan: "THIS ENTIRE PAGE NEEDS A FULL AUDIT, ENHANCEMENT,
IMPROVEMENT, BUG HUNT AND OPTIMIZATION OF EVERY PAGE AND SUB PAGE ... IMPROVE
THE UI TO THE MAX IT IS CURRENTLY TRASH. ADD THE #SMARTERCASINOREALISM."

## What was live and wrong (read from production on 2026-09-04)

Every item below was observed on the deployed page or read from the database,
not inferred.

| #   | Defect                                                                                                                                   | Evidence                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ROI rendered `+1.6500000000000001%` in the hero                                                                                          | live DOM text; raw ratio x100, never rounded                                                                                                          |
| 2   | Streak multiplier advertised `1.7x` for a 7-day streak                                                                                   | page computed `1 + streak * 0.1`; `fn_get_streak_multiplier(7)` pays 1.5                                                                              |
| 3   | VIP tier derived from DIAMONDS against thresholds (bronze 0 / silver 1k / gold 5k / platinum 50k / diamond 500k) that exist nowhere else | `/vip` derives tier from `vip_points.current_points` via `constants/vipTiers` (platinum at 15k, diamond at 50k, royal at 150k)                        |
| 4   | `VIPBadge` never rendered for anyone                                                                                                     | `profiles.tier` is `Newcomer` for all 1,310 rows; the badge only accepted bronze..diamond                                                             |
| 5   | VIP benefits were four hardcoded strings                                                                                                 | per-tier rakeback / multiplier / tickets / priority live in the constants                                                                             |
| 6   | Header printed `username` (`kingfish`); the tables print the alias (`KingFish`)                                                          | `playerDisplayName(row, 'arena')` is the resolver every table uses                                                                                    |
| 7   | Edit Profile wrote `profiles.username` AND `users.username`                                                                              | `idx_profiles_username_lower` is a case-insensitive unique index; a taken name failed with a generic message                                          |
| 8   | Edit Profile offered six dicebear avatar URLs and never saved the choice                                                                 | production CSP `img-src` does not allow api.dicebear.com; `onSave` never wrote `avatarUrl`                                                            |
| 9   | Achievement progress divided by `training_achievement_definitions.threshold`                                                             | that column is 0 for every row: NaN / Infinity progress bars; `/achievements` uses the client definitions                                             |
| 10  | The "P/L" chart was built from `wallet_transactions`                                                                                     | buy-ins, add-ons, diamond purchases and VIP charges netted by day; the real `daily[]` P/L series was already in the v2 stats payload the page fetched |
| 11  | "Hands 750" in the hero                                                                                                                  | 750 is the capped analysis window; lifetime is 1,412 (`lifetime.hands`)                                                                               |
| 12  | Portrait `loading="lazy"` on the LCP image; header portrait preference ignored                                                           | `resolveHeaderPortrait` is what the orb uses                                                                                                          |
| 13  | Session cache dropped bio and tags: a flash of an incomplete header on every revisit                                                     |                                                                                                                                                       |
| 14  | "Profile Synced" status was decorative                                                                                                   | now `Last Hand 12m Ago` from `coverage.last_hand_at`                                                                                                  |
| 15  | Change Avatar opened a new tab with `window.open` and no `noopener`                                                                      | same-origin `location.assign`                                                                                                                         |
| 16  | Public profile showed **Bronze** on every player                                                                                         | `vip_points` is owner-only by RLS and `profiles.tier` is never set; the fallback was the only branch reachable                                        |
| 17  | Public profile showed **Level 1** on every player                                                                                        | `profiles.level` is 1 for all 1,310 rows                                                                                                              |
| 18  | Public achievement showcase could never render                                                                                           | `mapProfile` never populated it; `training_user_achievements` is owner-only                                                                           |
| 19  | QR code fetched from `api.qrserver.com`                                                                                                  | every dossier view sent the player's URL to a third party; `qrcode.react` was already installed and unused                                            |
| 20  | Share wrote to the clipboard without `await` or `catch`                                                                                  | a denied permission was an unhandled rejection under a "copied" toast                                                                                 |
| 21  | Public profile had no poker record at all                                                                                                | `player_stats` is `SELECT true` by policy                                                                                                             |
| 22  | Report was hidden while a player was blocked                                                                                             | staff review needs the report regardless                                                                                                              |
| 23  | Errors from two Supabase reads were discarded                                                                                            | ratchet baseline for ProfilePage tightened 1 -> 0                                                                                                     |
| 24  | `src/pages/ProfilePage.css` (415 lines) imported by nothing                                                                              | deleted                                                                                                                                               |

## Design direction

Palette: Obsidian `#05070a`, Carbon `#0d1218`, Gunmetal `#26333d`, Chrome
`#b8c3cd`, Energy Cyan `#00d4ff`, Club Blue `#4169e1`, VIP Gold `#ffc93c`.
Rajdhani for the credential and every tabular figure, Roboto Condensed for
operational labels, Inter for body copy. Corner radii 2-3px, machined plates,
no per-panel backdrop filters, no pill radii, no hover states (law).

Two purpose-rendered assets, generated for these routes and compressed:

- `public/images/profile/identity-dock-v1.webp` (46 KB, 1536x1024) + 768 variant
  (14 KB): a black anodised credential dock with a chrome medallion socket, a
  blue crystal core and chips. Backs the own-profile credential.
- `public/images/profile/public-dossier-v1.webp` (29 KB) + 768 variant (9 KB):
  an upright dossier plate in a chrome holder with an EMPTY portrait medallion.
  On viewports >= 900px the player's arena avatar is set INTO that socket: the
  header is a `container-type: inline-size` stage at the render's aspect and
  the medallion is translated to the socket's measured centre (64.55%, 27.88%)
  at its measured width (10.35%). Below 900px the plate is a dimmed backdrop and
  the medallion returns to the copy.

Layout (own profile): credential plate (eyebrow + live status, chrome portrait
ring in the tier colour, handle, player number, member-since, VIP flag, bio,
tags, streak plate) -> integrated telemetry rail (lifetime hands, VPIP/PFR,
tourney ROI, hours on felt, diamonds, VIP points) -> actions console (Change
Avatar, Edit Profile, Share Profile, Cashier) -> VIP plate (tier from
`vip_points`, progress to next tier, the tier's real privileges) -> workspace
destinations (unchanged, law) -> recent distinctions -> four panels.

## Changes

- `src/pages/ProfilePage.tsx` rebuilt. Reads `vip_points`; tier via
  `getTierByPoints`; handle via the arena resolver; portrait via
  `resolveHeaderPortrait`; achievements via `achievementService`; stats via the
  extracted reader; every number formatted.
- `src/utils/profileStats.ts` (new): the v2 payload reader, now carrying
  lifetime hands, cap flag, showdown figures, hours, cash/tourney split, ITM,
  best finish, cashes, net, `daily[]`, `sessions[]`, `variants[]`.
- `src/utils/streakMultiplier.ts` (new): `fn_get_streak_multiplier` mirrored.
- `src/utils/format.ts` (+10 exports): `formatPct`, `formatSignedPct`,
  `formatSignedChips`, `formatChips`, `formatCount`, `formatRatio`,
  `formatHours`, `relativeTimeTitle`, `formatMemberSince`, `ordinal`.
- `src/components/profile/ProfitChart.tsx`: takes `series` (daily hand results),
  cumulative curve, zero reference line, red stroke when under water, tooltip
  with day P/L and hands.
- `src/components/social/UserProfileEdit.tsx`: edits the arena handle
  (`alias`) with validation, no avatar picker, a Studio button that opens the
  avatar studio, a note that the social photo is never shown at the tables.
  `ProfilePage.saveProfile` checks the handle against every other player's
  alias and username (case-insensitive) before writing.
- `src/pages/PublicProfilePage.tsx` rebuilt: arena avatar + handle, member
  since, player number, tags, presence, arena record from `player_stats`
  (hands-weighted VPIP/PFR via `src/utils/arenaRecord.ts`), local QR via
  lazy `qrcode.react`, awaited share with `navigator.share` first, Report
  reachable while blocked, a real not-found state with actions.
- `src/pages/ProfilePage.module.css`, `src/pages/PublicProfilePage.css`
  rewritten to the direction above. `src/pages/ProfilePage.css` deleted.
- Tests: `tests/unit/profileCredential.test.ts` (27 pins covering every row
  in the table above); `playerIdentityVault.test.ts` pin moved from the
  deleted avatar picker to the tag toggles; ratchet baseline tightened.

## Real-Time Law

Presentation and data-source change only. The page's bus subscriptions
(`PROFILE_UPDATED`, `HAND_COMPLETED`, `BALANCE_UPDATED`,
`DIAMOND_BALANCE_CHANGED`, `DAILY_REWARD_CLAIMED`, `MISSION_CLAIMED`,
`WHEEL_SPIN_RESULT`) are intact; `PROFILE_UPDATED` now triggers a full reload
rather than a partial one so alias/bio/tag edits propagate. No polling, no
timer refresh, no page-level realtime channel (2026-08-24 rule).

## Horses

No `is_horse` filter anywhere in these surfaces. `player_stats` rows and
`profiles` rows are read identically for horses and humans.

## Verification

- `tsc --noEmit -p tsconfig.app.json`: 0 errors.
- Targeted suites (profileCredential, playerIdentityVault,
  arenaAvatarSeparation, pageWaterfalls, discardedErrorReadRatchet,
  stats-v2-foundation, no-hover-effects): all green.
- Production Vite build: passes (see PR).
- Visual verification at 1280 and 375 wide: see PR.
