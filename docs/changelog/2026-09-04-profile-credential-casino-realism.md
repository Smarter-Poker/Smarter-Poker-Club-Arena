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

## Reconciled with PR #3041 (2026-09-05)

A second agent audited the same routes in parallel from another of Dan's
sessions and landed first (#3041: profile, public profile, settings and
notifications, with two rulings this branch did not have: "THERE IS NO SUCH
THING AS 'PLATINUM VIP'. JUST VIP, AND LIFETIME VIP", "THERE IS NOTHING
UNLIMITED LIKE THROWABLES OR TIME BANKS", and "ABSOLUTELY ZERO ROUNDING
ANYWHERE EVER"). Where the two passes overlapped, #3041's version is kept as
the base and its rulings govern: the VIP plate reads `utils/vipStatus`
(VIP / Lifetime VIP / none) and `VIP_GOLD_LIMITS`, never a points ladder; the
alias editor is #3041's (`utils/aliasRules`, username + alias written
together, 23505 on collision); the credential and dossier renders are
`public/images/account/*`; every figure truncates.

What this branch still adds on top of #3041, because #3041 did not touch it:

| Fix                                                                                                                                                                                            | Where                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Streak multiplier mirrors `fn_get_streak_multiplier` (7 days = 1.5x, not 1.7x)                                                                                                                 | `utils/streakMultiplier.ts`, hero                   |
| Achievement progress from the client definitions (`threshold` is 0 on every DB row: NaN bars)                                                                                                  | `achievementService` in the loader                  |
| Cumulative P/L from the payload's settled `daily[]` series, not wallet flow                                                                                                                    | `ProfitChart` + Activity panel                      |
| Recent sessions, by-variant results, WTSD, won-at-showdown, hours, worst hand, ITM, best finish, cashes, tournament net                                                                        | Snapshot + Activity panels, `utils/profileStats.ts` |
| Lifetime hands in the rail; "Hands Analyzed" when the 750-hand window is capped                                                                                                                | telemetry rail                                      |
| "Last Hand 12m Ago" from `coverage.last_hand_at` instead of a decorative "Profile Synced"                                                                                                      | hero status                                         |
| Invented financial milestone badges removed; the two orphaned gamification components deleted                                                                                                  | Distinctions panel                                  |
| Public dossier: arena record folded from `player_stats` (hands-weighted VPIP/PFR, tourneys, titles, clubs) replacing the "Level 1" badge that every row carried                                | `utils/arenaRecord.ts`                              |
| Report reachable while a player is blocked                                                                                                                                                     | dossier actions                                     |
| Float-safe truncation: `2183.7 * 100` is `218369.99999999997`, so a bare trunc printed `-2,183.69` for a ledger row of `-2,183.70`; a one-in-a-billion nudge toward the sign before truncating | `truncTo` in ProfilePage, `utils/format.ts`         |
| A discarded Supabase error on the visibility refresh bound and reported; ratchet 1 -> 0                                                                                                        | ProfilePage                                         |

The medallion-socket composition (the arena avatar set into the plate at its
measured centre) that this branch built against its own renders is NOT carried
over: #3041's renders are different geometry and the technique would need
re-measuring against them. Recorded under "What is left" below.

## The dossier's class names were global, and one of them broke it (2026-09-05)

`PublicProfilePage.css` was a plain stylesheet, so all 37 of its class names
were global. Ten of them are ALSO defined, bare, in 30+ other stylesheets.
Its own rules are scoped (`.public-profile-page .action-btn`) and so win any
property they DECLARE - but a property they do not declare is won outright by
whichever foreign rule loaded last.

Measured on the built bundle, not reasoned about. `src/components/admin/
PlayerSearch.css` declares a bare `.action-btn { width: 32px; height: 32px }`
for a 32px admin icon button. The dossier never declares `width`. Result, in
production:

    grid tracks   123px 123px 123px 123px 123px
    the buttons    36px  36px  36px  36px  36px   <- "Add Friend" wrapping

Worse under the worst case (every route chunk loaded, which is any session
that visited the hand replayer first): `.share-btn` there is
`position: absolute; bottom; left; z-index: 10`, so Share LEFT THE GRID:

    before  156px 156px 156px 156px 0px   Share: 680px, position absolute
    after   123px 123px 123px 123px 123px Share: 123px, position static

Fixes, in order of root-ness:

1. `PlayerSearch.css` scoped to `.player-search .action-btn` - the leak at
   source. The admin buttons are unchanged.
2. `PublicProfilePage.css` -> `PublicProfilePage.module.css`, all 37 class
   names hashed, TSX switched to `styles.*`. No foreign stylesheet can match
   them again. `share-btn` is deleted rather than renamed: the page never
   styled it, so it was purely a socket for other people's CSS.
3. Five text rules qualified with the page class, because the app shell styles
   `h1`/`h3` through descendant rules of equal weight that were winning on
   load order and drifting the player's name from 800/-0.03em to 500/+0.03em.

Verification is a computed-style diff of all 41 elements, clean vs every
stylesheet in the app force-loaded: **52 property diffs before, 25 after**, and
every remaining one belongs to the shared `PlayerAvatar` component (its level
badge and portrait sizing), which is not this page's to own - recorded below.

## The same leak class, everywhere (2026-09-05)

The `.action-btn` collision above was not one bad rule, it was one instance of
a shape. A scanner over all 486 plain stylesheets - a class is "bare" when the
whole selector is a single compound, so `.a .b` and `.page .a` do not count -
found **256 class names defined bare in more than one file with a property
gap**, meaning one file declares something another does not and that property
crosses pages on chunk load order.

Two of the 256 were the ones sitting under this audit's own surfaces:

| class            | bare definitions                                                                                                     | what it cost                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `.action-btn`    | 6 (PlayerSearch, AgentCashoutPanel, ActionCard, ShareableHighlight, HandReplay, DisputeManagementPage)               | 36px action buttons on the dossier                    |
| `.player-avatar` | 7 (PlayerAvatar + PlayerCard, PlayerSearch, AgentCashoutPanel, InviteToTable, SuperAgentDashboard, HandReplayerPage) | portrait 78px -> 74px, badge gained a ring and a glow |

All six foreign `.player-avatar` definitions style their OWN markup - none of
them renders `<PlayerAvatar>`, verified per file - so each was pure collision
with the shared component. Scoping each to the container it belongs to is
behaviour-preserving for the owner and removes the leak for everyone else.

**256 -> 254.** The remaining 254 are logged, not fixed: they belong to
surfaces outside this audit and each is the same two-line change.
`tests/global-css-does-not-leak-across-pages.law.test.ts` pins `.action-btn`
at zero bare definitions, pins `.player-avatar` to its one owner, and ratchets
the total so the count can fall but never rise. It immediately earned its keep
by catching two indented `.action-btn` rules inside media queries that a
line-anchored grep had missed.

## The VIP ring nobody has ever seen (2026-09-05)

`FriendListPanel` selected `profiles.tier` and passed it to `PlayerAvatar` as
`(p?.tier as VipTier) || 'bronze'`. `profiles.tier` is a RANK label: it reads
`'Newcomer'` on **1,310 of 1,310** production rows. It is not the VIP column -
VIP is `is_vip` / `vip_tier` / `vip_expires_at`, which `utils/vipStatus`
already resolves and which this branch's credential already uses.

`'Newcomer'` is truthy, so the `|| 'bronze'` fallback never fired, and
`'Newcomer' !== 'bronze'` is true, so the ring element always rendered - as
`class="vip-status-ring tier-Newcomer"`. The base rule carries only geometry;
every colour lives on a `.tier-*` class. So the ring was in the DOM and
invisible, for every player, and an actual Lifetime VIP got no ring either.
The `as VipTier` cast is what kept the compiler quiet about all of it.

Three fixes, and a check that was already written down:

1. `PlayerAvatar` validates the tier against the five its stylesheet paints
   before rendering the ring. This is CLAUDE.md section 5 rule 4 - "VIP levels
   must be validated before rendering badges" - applied where it was missing.
2. `FriendListPanel` selects the three real VIP columns and resolves them with
   `resolveVipStatus`. Lifetime renders the diamond ring, VIP the gold ring,
   everyone else none. That is a presentation of a two-state fact in the ring
   vocabulary that already exists, not a revived ladder.
3. `LeaderboardPage` was left alone: it passes gold/silver/bronze for ranks
   1/2/3 deliberately, as a podium medal, and every value it passes is valid.

`ProfileService.addVIPPoints` and its `VIP_THRESHOLDS` are DELETED rather than
corrected. It had no callers in `src/`, `server/` or `tests/`, and it was
wrong three ways over: it started from `profile.vipPoints`, which `getProfile`
hardcodes to 0 because `profiles` has no `vip_points` column; it derived a
bronze -> diamond tier that Dan's 2026-09-04 ruling says does not exist ("JUST
VIP, AND LIFETIME VIP"); and it wrote the result to `tier`, the rank column,
not to any VIP column. Its thresholds also disagreed with
`src/constants/vipTiers.ts` at every rung above 5,000 - platinum at 25,000 vs
15,000, diamond at 100,000 vs 50,000, and no `royal` at all. A dead ladder left
in a service file is how the next agent revives one.

## What is left

- Set the portrait INTO #3041's credential plate ring and the dossier folio
  frame (measure the socket centre and size, `container-type: inline-size`
  stage at the render's aspect, translate the medallion). The technique is in
  this branch's history (commit 62f49ffd9, `PublicProfilePage.css`).
- One RPC for the credential (`profiles` + `vip` flags + stats + achievements
  - ledger) to replace five round trips on a cold mobile load.
- `BonusService.getWheelStats` carries a third streak ladder (1.5x at 3-6,
  2x at 7+) that matches neither the SQL nor the profile.
- The mutual-friend chips still print social usernames on an arena surface.
- `training_achievement_definitions` (threshold 0, icon_url null on every
  row) is a dead mirror of the client `ACHIEVEMENTS`; pick one source.
- 254 class names are still defined bare in more than one stylesheet with a
  property gap between them (down from 256). Each is a live cross-page
  collision and each is the same two-line fix; the law ratchets the count.

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
