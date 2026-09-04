# Stats Page Programme (2026-09-03)

Target surface: `https://smarter.poker/hub/club-arena/stats`
Routes: `/stats`, `/stats/:userId`, `/clubs/:clubId/members/:userId/statistics`
Source: `src/pages/PlayerStatsPage.tsx` (2,809 lines), `src/components/stats/*`
(19 components, 5,347 lines), `src/pages/PlayerStatisticsPage.tsx` (374 lines,
the club-staff member view), `src/components/agent/DownlineRakePanel.tsx`.
Status: PROGRAMME. Everything below is either verified against the code and
the production database on 2026-09-03, or marked `[verify]` where the next
agent must read before acting.

This is the complete list of what is left on the stats surface: every tab,
every sub-page, every data defect still open, every improvement, and the full
`#SmarterCasinoRealism` visual rebuild. Work it top to bottom. Section 1 ships
before section 7: a showroom built around wrong numbers is a worse page than
the one we have.

The visual standard is `#SmarterCasinoRealism`. Every agent doing section 7
reads the skill document in full (`smarter-casino-realism`, or the verbatim
prompt in section 7.1) and passes it to every subagent it spawns. The one
sentence that matters: **the page should feel rendered, not styled.**

---

## 0. Where the surface stands (after PR #2874)

### 0.1 What is verified live

- Money is exact. `ca_player_stats_overview_v2` reads the engine's own
  settlement row per hand (`hand_history.settlements`) for 351 of 353 cash
  hands on the reference account; the two without a settlement row are being
  repaired by `ca-stats-money-repair` (pg_cron, 4,000 hands every 5 minutes,
  self-unschedules when `ca_hand_player_stat_repair_state.done`).
- Numbers are live. `trg_ca_stats_live_from_hand` writes the per-hand stat
  rows in the same transaction as the hand insert (2-5 ms warm per hand). The
  page subscribes to its own hands over Realtime from any tab; the header pill
  reads Live.
- The hand index (`ca_hand_player_idx`) loops under a time budget instead of
  a 3,000-hand cap; it was 17 hours behind and is now current.
- Range selection is honoured by every panel; the second, contradicting range
  selectors inside Position/Session/Bankroll/Advanced are gone.
- Worst Losses ranks cash only; Tournaments honours the range; the three
  "over N hands" trophies can unlock; four panels no longer say "not gathered
  yet" on a network error.
- `tests/stats-money-exact-and-live.test.ts` pins all of the above.

### 0.2 The page as it exists

Header: `stats-command-deck` (eyebrow "Club Arena // Player Analytics", h1
"Player Intelligence", one sentence, the dossier render
`public/images/stats/player-intelligence-dossier-v2.webp`), range control
(7 Days / 30 Days / 90 Days / All), Live pill, last-updated line.

Tabs (`BASE_TABS` + owner-only `hands`, `trophies`; staff/agent `rake`):

| Tab         | Sections rendered                                                                                                  | Components                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Overview    | Evidence At A Glance (intelligence brief), Core Tendencies, Game Mix, Stake Ledger, Nemesis, Benchmark, Share Card | `StatGrid`, `NemesisPanel`, `BenchmarkPanel`, `StatsShareCard`             |
| Performance | EV vs Actual (luck), Preflop, Postflop, Results                                                                    | `EVLuckChart`, `StatGrid`                                                  |
| Positions   | Positional radar, per-position win rates                                                                           | `PositionalRadar`, `PositionWinRates`                                      |
| Hands       | 13x13 hole-card grid (owner only, privacy)                                                                         | `HoleCardHeatmap`                                                          |
| Tournaments | Tournament Results, Recent Tournaments                                                                             | inline grids + table                                                       |
| Analysis    | Advanced Stats, Charts, Notable Hands, Cash Sessions, Cash Bankroll                                                | `AdvancedStatsSummary`, `StatsCharts`, `SessionHistory`, `BankrollTracker` |
| Trophies    | Trophy Room (common / rare / epic / legendary)                                                                     | `TrophyRoom`                                                               |
| Rake        | Downline rake attribution (agents, staff)                                                                          | `DownlineRakePanel`                                                        |

Sub-pages: the print dossier (`printDossier`, renders every tab and prints),
the share card (PNG of the range summary), and
`PlayerStatisticsPage` (club staff view of one member, month / custom range,
lifetime totals).

### 0.3 The data spine (do not rebuild it, extend it)

`hand_history` (7-day prune for horse-only hands, Dan's ruling in CLAUDE.md
10.5) -> `trg_ca_stats_live_from_hand` -> `ca_hand_player_facts()` ->
`ca_hand_player_stat` (per player per hand, the most recent 1,000 per player,
pruned by count and never by the hand pruner, so it survives day 8) ->
`ca_player_stats_overview_v2(p_user, p_days)` (asserts `auth.uid() = p_user`
via `ca_assert_self`) -> page. `ca_hand_player_idx` is the per-player hand
index the "Hands Played" count and the notable-hands list read.

---

## 1. Data and correctness backlog

Ordered by player impact. Each item names the evidence, the fix, and the pin.
Every fix that touches money goes through CLAUDE.md 11.5 (probe in a rolled
back transaction first) and 10.9 (you decide it, you write the paragraph).

### 1.1 Position labels: CLOSED 2026-09-04, the button is right

The 2026-09-03 changelog claimed ~3% of hands carried a `button_seat` that
disagreed with the action order. Measured properly in phase 1 against 48,362
hands: 47,871 carry blind-post rows and on every one the stored button is the
seat before the small-blind poster (the poster itself heads-up). Zero
disagreements. The "3%" was a first-to-act heuristic that did not know about
straddles (533 of 551 flagged hands) or an all-in small blind who never gets
a turn (the other 18). The derived `showdown` flag was checked against the
engine's `hand_history.showdown` roster the same way: 27,418 player-hands,
zero disagreements.

What shipped instead is the tripwire: `ca_stats_witness_audit()` re-runs
both comparisons every 15 minutes and the engine pages on any non-zero
count (`docs/changelog/2026-09-04-stats-phase-1-witness-audit.md`). If a
real recording defect ever appears, it is found within 15 minutes, with the
hands in its window named in `ca_stats_witness_audit_log`.

The verification pass then found a real one, of a different kind: 57 horses
with synthetic ids had stat rows and no index rows because the index
writers' uuid regex demanded RFC 4122 bits the stat writer did not. Fixed,
backfilled, and the audit now counts seats without an index row (changelog
section 4).

### 1.2 Finish the money repair and re-measure the hand write

- Watch `ca_hand_player_stat_repair_state` until `done = true`. Then confirm
  `SELECT count(*) FROM ca_hand_player_stat WHERE settlement_source IS NULL`
  is zero for hands that have a settlement row `[verify column name]`.
- Re-measure the engine's `hand_history` insert mean in
  `pg_stat_statements` (57.6 ms before this work; 267 ms while the repair ran
  at half duty; trigger alone 2-5 ms warm). If the steady-state mean is above
  ~70 ms after the repair finishes, the trigger is the cost and it moves off
  the insert path (enqueue on insert, drain from a 1-second pg_cron tick).
- Add the hand-write mean to the Grafana engine board with the maintenance
  break guard (CLAUDE.md 13.6).

### 1.3 Index lag must page, not surprise: DONE 2026-09-04 (phase 1)

`StatsHealthMonitor` reads `ca_stats_health()` every minute, publishes
`/health.stats` and `poker_stats_*`, raises `ClubArenaStatsIndexLag` at 30
minutes (break-suppressed) and the `stats-pipeline` Prometheus group is the
second path. The original ask, for reference:

The hand index fell 17 hours behind and nothing said so. Add
`ca_hand_player_idx_state.idx_ceil` lag to `/health` (`statsIndexLagSeconds`)
and an alert rule at 30 minutes with the break guard. Pin the health field in
`tests/`.

### 1.4 EV coverage audit

The EV vs Actual chart reads the equity the engine persists to
`ca_hand_facts` by intercepting the `all_in_equity` event in
`server/src/services/supabase/handFacts.ts` (verified). Confirm coverage:
what fraction of all-in hands in the last 7 days have it populated, cash and
tournament separately, and whether run-it-twice hands carry both boards. Any all-in hand
without equity is a silent hole in the luck line. Add a row to
`financial_alerts`-style monitoring (or a nightly check) when coverage drops
below 99%.

### 1.5 Tournament results are not live

Cash hands feed the page live through the trigger. Tournament finishes
(position, prize, bounty) come from the tournament tables. Subscribe the
Tournaments tab to the player's own `tournament_players` (or the table the
overview reads `[verify]`) so a finish updates the page without a refresh, on
the same Realtime channel.

### 1.6 Sessions: define and pin the boundary rule

`SessionHistory` derives sessions client-side from hand timestamps. Write the
rule down (gap threshold, table change, day boundary), move it into the RPC so
the print dossier, the share card and the club-staff view agree, and pin
"session profit equals the sum of its hands' settlements" as a law test.

### 1.7 Benchmarks against the real field

`statBenchmarks.ts` holds static reference values. Replace with a nightly
rollup of the platform's own population (`ca_field_percentiles`: VPIP, PFR,
3-bet, WTSD, W$SD, aggression, per game and stake band; horses included,
CLAUDE.md 10.5) so the Benchmark panel shows a true percentile. Keep the
static values as the fallback when the rollup is empty and say so on the
panel.

### 1.8 Nemesis and Target: source of truth

`NemesisPanel` reads `ca_hand_transfers`, written at settlement (verified in
the component header). Left: pin with a test that a hand's transfers sum to
the settlement row for every player in it, and confirm the engine writes
transfers for tournament hands as well as cash `[verify in
`server/src/services/supabase/handFacts.ts`]`.

### 1.9 Trophies persist server-side

Trophies are computed from the current payload. A trophy unlocked at 1,000
hands re-locks if the window or the hand cap moves. Add
`ca_player_trophies(user_id, trophy_id, unlocked_at)`, write on first unlock
(idempotent), read for display, raise a toast (Title Case, no em dashes,
through the Toast provider) on a fresh unlock. Horses earn trophies too.

### 1.10 Rake tab at scale

`DownlineRakePanel` caps at 500 rows and warns. Move the search and the
cap server-side (keyset pagination on the RPC) so a large agent tree is not
truncated, and keep the unfiltered summary exact regardless of the page.

### 1.11 `/stats/:userId` privacy policy, written down

`hands` is hidden for other users (holdings never shown at showdown) and the
database refuses cross-user reads. Decide and document which panels a
non-owner may see at all (Overview aggregates yes; Nemesis names opponents,
so probably not; Rake is staff/agent only). Put the matrix in this file's
successor and pin it.

### 1.12 Club-staff member view parity

`PlayerStatisticsPage` (month / custom date range, lifetime totals) reads
`ClubRosterService.getMemberStatistics` (verified), a separate path from the
player's own page. It must read the same exact-settlement money
as the player's own page, or two people looking at one member will see two
profits. Move it onto `ca_player_stats_overview_v2` with a staff-scoped
wrapper (`ca_assert_club_staff`), keep the custom range, and share the
components from section 7 so it is visually the same room.

### 1.13 Horses-are-players sweep of every stats RPC

Grep every `ca_player_*` and `ca_field_*` function for `is_horse`. The only
legitimate uses are identification (a badge) and the horse's input device.
Any `p_include_horses` parameter defaults to true. Leaderboard and benchmark
populations include horses.

### 1.14 Retention law: DONE 2026-09-04 (phase 1)

`tests/the-stats-a-player-reads-survive-the-hand-prune.law.test.ts`, in
`docs/LAWS.md`: `sp_prune_hand_history` never names `ca_hand_player_stat`,
`ca_hand_facts` or `ca_hand_transfers` (it MAY prune `ca_hand_player_idx`,
the pointer table, and does); `ca_prune_hand_player_stat` keeps at least the
page's 750-hand window; the forward roll prunes by per-player count, never by
age. Note the correction to what this section first said: the idx table is
pruned with its hands by design, it is the stat, facts and transfers tables
that must never be.

### 1.15 Time zone on ranges

"7 Days" is evaluated in UTC. A Chicago player at 11 pm sees today's hands
split across "days". Evaluate day boundaries in the player's browser zone
(pass `p_tz` or an explicit `since` timestamp) and say which days on the
brief. Small, but every "which day was that" support question starts here.

### 1.16 PLO hole-card grid

The 13x13 grid is a Hold'em object. Confirm what the Hands tab shows for a
PLO-only range (`[verify]`: it should say PLO hands are not on the grid and
offer the PLO summary, not an empty grid).

---

## 2. Tab-by-tab inventory: exists, left, improve

### 2.1 Header and range control

Exists: eyebrow, h1, one-line description, dossier render, four ranges, Live
pill, last-updated line, range memo across visits.
Left: deep link the tab and range (`?tab=positions&range=30d`) so a share or
a support ticket lands on the right view; keyboard shortcut for range.
Improve: the last-updated line should read the newest hand's time in the
player's zone and tick without a refetch.

### 2.2 Overview

Exists: intelligence brief (five evidence items with index), Core Tendencies,
Game Mix, Stake Ledger, Nemesis, Benchmark, Share Card.
Left: 1.7 (true percentiles), 1.8 (nemesis source), 1.11 (non-owner matrix).
Improve: the brief's five items are the page's editorial hook; give each a
"why it matters at the next table" line sourced from `statsIntelligenceBrief`;
the Stake Ledger should carry a per-stake bb/100 with the sample size beside
every rate.

### 2.3 Performance

Exists: EV vs Actual line with the luck band, Preflop / Postflop / Results
grids.
Left: 1.4 (EV coverage), tournament EV (chips, not dollars, labelled).
Improve: a "luck" readout in words (running above / below expectation by X
over N all-ins), hover to the hand, click through to the hand replay when a
replay exists `[verify replay route]`.

### 2.4 Positions

Exists: positional radar (3-bet per opportunity), per-position win rates,
keyboard-activatable rows, evidence footnote.
Left: 1.1 (button derivation) before anything else here is trusted.
Improve: show hands per position with the rate (a 60% BTN win rate over 5
hands is noise); PLO and short-handed tables use different position sets,
label the table size.

### 2.5 Hands (owner only)

Exists: 13x13 heatmap from `ca_hand_facts.hole_cards`, sample gating.
Left: 1.16 (PLO), small-sample shading rule documented.
Improve: tap a cell to list the hands; toggle metric (VPIP / PFR / won / net
bb); a "you have never been dealt" overlay for cells with zero samples.

### 2.6 Tournaments

Exists: results summary, recent tournaments table honouring the range.
Left: 1.5 (live finishes), ROI and ITM with the sample size, bounties and
rebuys shown as their own columns.
Improve: click a row to the tournament results page; a finishing-position
distribution strip (1st / final table / ITM / bust).

### 2.7 Analysis

Exists: Advanced Stats, Charts, Notable Hands (cash only, labelled),
Cash Sessions, Cash Bankroll.
Left: 1.6 (session rule), `BankrollTracker` is pure presentation of the
page RPC's sessions (verified), so the line is cumulative session P/L, not
the wallet; either rename it Cumulative Cash P/L or read the wallet ledger
for deposits and withdrawals and label it Bankroll. Do not leave the name
saying one thing and the line another.
Improve: notable hands need a hand-replay link; sessions need a per-table
break-down; the Charts block is generic and becomes the instrument wall in
section 7.

### 2.8 Trophies (owner only)

Exists: four rarities, progress bars, all-time payload.
Left: 1.9 (server-side unlocks + toast), horses earn them.
Improve: rendered medallions per rarity (section 7.3), a locked slot that
says exactly what unlocks it, a share of a single trophy.

### 2.9 Rake (staff / agents)

Exists: weighted attribution, search, 500-row cap warning, NaN-guarded rate.
Left: 1.10 (server-side pagination).
Improve: period selector aligned to the page range; export to CSV through the
existing export path.

### 2.10 Print dossier

Exists: renders every tab (`printing` short-circuits `showTab`), hides only
loading fallbacks, dark axes for print.
Left: a cover block (name, range, generated-at, page count); page breaks
between tabs; the dossier render as a header strip; verify in Safari and
Chrome print preview on the Mac (real hardware, CLAUDE.md 10.4).

### 2.11 Share card

Exists: PNG of the range summary with the window drawn on the card.
Left: the card background becomes a render (section 7.3); include the
player's display name and the club; verify the share sheet on iOS Safari.

### 2.12 Club-staff member view

See 1.12. Also: custom date validation copy is Title Cased already; the
"Showing Lifetime Totals" state needs the same Live pill semantics.

---

## 3. Dead code and consolidation (one PR, no behaviour change)

- Delete `PerformanceTrends`, `StakeLevelComparison`, `PlayerStyleRadar`
  (its axes are fabricated), `LeakPanel`, `StatsExportButton`: exported and
  rendered nowhere. Update the barrel `src/components/stats/index.ts` and the
  identity-vault test that names them in the same commit (CLAUDE.md 5.8).
- `findLeaks.ts`, `playerStyleFromStats.ts` go with their panels unless
  section 2 re-uses them; say which in the PR.
- Split `PlayerStatsPage.tsx` (2,809 lines) into one lazy chunk per tab
  (`src/pages/stats/<Tab>Tab.tsx`) behind the existing `showTab`; the header,
  range control and Realtime subscription stay in the page. Print mode
  renders every chunk. This is what makes section 7 reviewable one tab at a
  time.
- Remove the inline header colours (`#8b5cf6` purple, `#22c55e` green,
  `#f59e0b` amber, `#3b82f6`) from the `<h3>` section headers; they are
  outside the palette and are replaced by the section header bar in 7.4.
- `PlayerStatisticsPage.css` duplicates stat-row styling; it consumes the
  section 7 components instead.

---

## 4. Behaviour and accessibility

- Tab strip: roving tabindex exists; add `?tab=` deep link and history
  entries so Back returns to the previous tab.
- Every panel is wrapped in `PanelBoundary`; make its error state the
  section 7 "instrument offline" plate with a Try Again, never a blank.
- Every number formats with `toLocaleString()` (CLAUDE.md 5.5); every rate
  shows its sample size; every chart has a text alternative table (the
  `stats-position-evidence` pattern) for screen readers and print.
- Popups only through the Toast provider (Title Case, no em dashes, dedupe).
- Reduced motion collapses motion, never meaning (`data-motion="keep"` on the
  live-update pulse and the EV line draw).
- Never auto-switch tabs on a live update; a live update on a hidden tab
  lights the tab's LED seam and nothing else (CLAUDE.md 10.6.2 spirit).
- Mobile swipe between tabs stays; verify it does not fight the heatmap's
  horizontal scroll at 375 px.

---

## 5. Performance

- Page chunking (section 3) drops the initial stats bundle; measure before
  and after with the production build (`vite build --report` `[verify flag]`).
- Recharts is loaded for the whole page; load it inside the tabs that draw.
- One Realtime channel per page, one subscription, filtered to the player's
  own rows; unsubscribe on route change (pin).
- Range change cancels the in-flight request (the `loadedRangeKeyRef`
  guard exists; add an AbortController so the old response is not parsed).
- Artwork: every render ships resized to 3x its measured render box through
  `scripts/optimize-arena-images.sh` (measure with `getBoundingClientRect`
  on the deployed page, as that script documents), WebP, hero <= 350 KB,
  tab plates <= 120 KB, medallions <= 40 KB each. Hero gets
  `fetchpriority="high"`; tab plates lazy-load.

---

## 6. Tests and laws to add

Each `*.law.test.*` needs a row in `docs/LAWS.md` (CLAUDE.md 10.8.1).

- `stats-money-conservation.law.test.ts`: for any hand, the sum of every
  player's settlement plus rake equals zero; the page's profit for a range
  equals the sum of the player's settlements in that range.
- `stats-horses-are-players.law.test.ts`: no `is_horse` filter in any
  `ca_player_*` / `ca_field_*` function body except identification.
- `stats-retention.law.test.ts`: the prune function never names the durable
  stat tables (1.14).
- `stats-visual-language.law.test.ts` (after section 7): no
  `backdrop-filter` in `src/components/stats/**` or `PlayerStatsPage.css`
  (14 files use it today); no `border-radius` above 6 px except `50%` on
  true circles and the `999px` pill on the Live indicator only; no inline
  hex colour in stats TSX; every `<img>` under `images/stats/` has a row in
  `docs/VISUAL-COMPOSITION-REGISTRY.md`.
- `stats-tab-deep-link.test.ts`, `stats-realtime-single-channel.test.ts`.
- Extend `tests/stats-money-exact-and-live.test.ts` for 1.1, 1.5, 1.9.

---

## 7. The `#SmarterCasinoRealism` visual programme

### 7.1 Intent and authority

Redesign the stats surface using the exact visual language of the
Smarter.Poker Marketplace / Diamonds page. Use the Marketplace screenshots as
the primary visual authority. The skill document `smarter-casino-realism`
carries the verbatim agent prompt; every agent and subagent on this section
reads it in full before touching a file.

Do not interpret this as black background + blue borders + gradients. The
target is a premium, hyper-realistic casino environment built from cinematic
3D artwork, precision metallic UI framing, extremely dark surfaces,
restrained electric-blue illumination, and crisp editorial layout.

The stats page is not a shop, so its room is not the showroom: it is the
**intelligence deck** of the same machine. Where the Diamonds page sells
objects, this page reads instruments. Same materials, same light, same
frames; the artwork is machinery that measures rather than product that is
bought.

Quality test, applied at every review: FAIL if it reads as a dark SaaS
dashboard, generic blue cards, standard components, glassmorphism, flat
illustration, CSS gradient art, arcade UI. PASS if it feels like a luxury
futuristic casino, premium gaming hardware, high-end product photography, a
cinematic digital showroom, an expensive physical machine translated into
software.

### 7.2 Page anatomy (the vertical rhythm, mapped to stats)

```
1  SEGMENTED NAVIGATION RAIL         Overview | Performance | Positions | Hands | Tournaments | Analysis | Trophies | Rake
   low profile, recessed, selected tab lit by a thin blue edge

2  CINEMATIC HERO: THE INTELLIGENCE CONSOLE
   LEFT                                   RIGHT
   small category label                   large 3D console render
   "Club Arena // Player Analytics"       chrome bezel, black glass,
   large editorial heading                holographic blue readouts,
   "Player Intelligence"                  chip stacks, machined base
   one sentence
   live plate: profit for the range, hands, Live pill

3  SECTION HEADER BAR (the threshold)
   "<Tab Name>"                                    7 Days | 30 Days | 90 Days | All   ·  Updated 2 minutes ago

4  INSTRUMENT GRID
   three columns on desktop, one on mobile; every panel is a machined
   instrument plate with the same frame system and its own render
```

Negative space is kept. Panels do not fill the row because there is room.

### 7.3 Artwork manifest

Every render is purpose-built, photorealistic, physically lit, and differs
from every other Club Arena composition on at least four of the six registry
axes (subject, camera, silhouette, light direction, depth, narrative action).
Every file gets a row in `docs/VISUAL-COMPOSITION-REGISTRY.md` before it
ships. Files live in `public/images/stats/`, WebP, sized per section 5.
No text, numbers, names or logos are baked into any render: every value on
the page stays HTML.

| #   | File                             | Where                  | Composition                                                                                                                                                                                                                                                                                                                                                   | Size (px)                        |
| --- | -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | `intelligence-console-hero.webp` | Hero, right side       | A machined analytics console: black anodized housing, chrome bezel, a curved black-glass display projecting a holographic blue waveform and rings, chip stacks and a card shoe on the deck, LED seams in the base. Camera three-quarter, slightly low. Key light from the hologram, rim from a cool practical above. Shallow depth of field on the far chips. | 2400x1350, mobile crop 1200x1500 |
| 2   | `plate-overview-ledger.webp`     | Overview header plate  | A brushed-steel chip tray with sorted stacks and a chrome dealer button, shot from above at a steep angle, single warm-cool split light                                                                                                                                                                                                                       | 1200x600                         |
| 3   | `plate-performance-gauge.webp`   | Performance / EV       | A glass-faced pressure gauge in a gunmetal housing, blue crystal needle, etched ring, macro camera at eye level, light through the glass                                                                                                                                                                                                                      | 1200x600                         |
| 4   | `plate-positions-ring.webp`      | Positions              | A top-down machined table ring, nine seat markers as recessed LED seams, one lit, black felt, chrome rail, camera straight down                                                                                                                                                                                                                               | 1200x1200                        |
| 5   | `plate-hands-vault.webp`         | Hands (owner only)     | A deck of black-and-chrome cards fanned in an anodized tray inside a small vault door, camera low and close, one card face catching a blue edge light                                                                                                                                                                                                         | 1200x600                         |
| 6   | `plate-tournaments-bracket.webp` | Tournaments            | A trophy vault: a single chrome cup on a black pedestal behind glass, restrained gold on the plinth, bracket machinery blurred behind, camera front-on                                                                                                                                                                                                        | 1200x600                         |
| 7   | `plate-analysis-vault.webp`      | Analysis / Bankroll    | A bankroll vault door ajar, chrome bolts, blue light from inside, camera three-quarter from the left, deep spatial depth                                                                                                                                                                                                                                      | 1200x600                         |
| 8   | `plate-rake-sorter.webp`         | Rake                   | A coin and chip sorting mechanism, chips on a chrome track, gunmetal gears, camera oblique, light from the track                                                                                                                                                                                                                                              | 1200x600                         |
| 9   | `medal-common.webp`              | Trophy Room            | A gunmetal medallion, matte, faint LED seam, camera front, soft top light                                                                                                                                                                                                                                                                                     | 512x512                          |
| 10  | `medal-rare.webp`                | Trophy Room            | A polished chrome medallion, sharp reflections                                                                                                                                                                                                                                                                                                                | 512x512                          |
| 11  | `medal-epic.webp`                | Trophy Room            | A blue crystal medallion in a chrome ring, internal light                                                                                                                                                                                                                                                                                                     | 512x512                          |
| 12  | `medal-legendary.webp`           | Trophy Room            | A gold medallion with a blue crystal core, the only gold on the page                                                                                                                                                                                                                                                                                          | 512x512                          |
| 13  | `medal-locked.webp`              | Trophy Room            | An empty recessed slot in black anodized metal, one dim seam                                                                                                                                                                                                                                                                                                  | 512x512                          |
| 14  | `share-card-bg.webp`             | Share card             | A black-glass plate with a chrome rule and a faint holographic ring, empty centre for the live numbers                                                                                                                                                                                                                                                        | 1200x630                         |
| 15  | `plate-idle.webp`                | Empty and error states | A dark idle instrument, display off, one standby LED                                                                                                                                                                                                                                                                                                          | 1200x600                         |

The existing `player-intelligence-dossier-v2.webp` and
`player-intelligence-console-v1.webp` are retired when #1 lands (keep them
in the additive asset pool; do not delete from `public/` in the same PR the
new hero ships, so an open tab still resolves them).

### 7.4 Frame system and tokens

Palette (the Club Members redesign already established it; reuse, do not
invent): Obsidian `#05070a`, Carbon `#0d1218`, Gunmetal `#27313c`, Chrome
`#b8c3cd`, Energy Cyan `#00d4ff`, Club Blue `#4169e1`, VIP Gold `#ffc93c`
(trophies and prize values only). Positive money `#2ee6a6` and negative
`#ff5c6c` are the only other hues, used for numbers, never for panels.

Layer stack, on every panel, in this order: exterior frame (1 px chrome,
`#b8c3cd` at 55%) -> inner stroke (1 px gunmetal) -> black panel (Carbon)
-> content -> render. Depth is stroke and value, not blur.

- Corners: 2-4 px, or a 6 px chamfer on the hero and the section header bar.
  No `border-radius` above 6 px except true circles and the Live pill.
- No `backdrop-filter` anywhere on the surface. No box-shadow glow halos;
  one 1 px LED seam (`#00d4ff` at 70%) marks the active or live element.
- Blue is energy: the selected tab edge, the live seam, the EV line, the
  active heatmap cell, the hologram in the render. Panels stay black.
- Section header bar: full width, Carbon on Obsidian, thin chrome rule top
  and bottom, tab name left in the editorial face, range control and
  updated-at right.

The Club Members redesign defined its palette locally
(`--members-carbon`, `--members-gunmetal` in `ClubMembersPage.css`) and
`src/styles/design-tokens.css` does not carry these names (verified). Define
them once as `--sp-obsidian`, `--sp-carbon`, `--sp-gunmetal`, `--sp-chrome`,
`--sp-cyan`, `--sp-club-blue`, `--sp-gold` in `src/styles/design-tokens.css`,
reference them from every stats stylesheet, and migrate the members page to
them in a follow-up so the two rooms cannot drift.

### 7.5 Typography

- Editorial headings: Rajdhani Light / Regular, tall, tracked +2%, 40-56 px
  desktop, 30-34 px mobile. Not bold.
- Instrument labels: Roboto Condensed, uppercase, tracked +8%, 11-12 px,
  Chrome at 70%.
- Figures: Rajdhani with `font-variant-numeric: tabular-nums` so live
  updates do not reflow; primary values off-white `#e9eef3`, secondary cool
  grey `#8d98a3`.
- Body copy: Inter / system sans, 14-15 px, never below 13 px on mobile.
- Title Case on every static word (the `check-title-case` and
  `check-painted-text-case` pre-push guards enforce it); no em dashes in any
  string a player reads.

### 7.6 Component treatments

- Navigation rail: replaces the pill tabs. Recessed dark track, segments
  separated by 1 px gunmetal, selected segment brighter text plus a 1 px
  blue bottom edge, hidden tabs (hands, trophies, rake) simply absent.
- Hero: asymmetric two-column at >= 900 px; render right, copy left, the
  live plate (range profit, hands, Live pill) as a small engineered plate
  under the copy. On mobile the copy stacks above a 3:4 crop of the render.
- Instrument tile (replaces `StatCard`): label top-left, value large with
  tabular figures, sample size or unit small under it, a 1 px seam at the
  bottom that lights for two seconds when the value changes live.
- Charts (Recharts theme in one module): 1 px chrome axes at 40%, no grid
  fill, cyan line 1.5 px, the luck band as a 1 px dashed chrome bound with a
  6% cyan fill only inside the band, tooltips as small black plates with a
  chrome edge. No area gradients, no rounded bars.
- Heatmap: 13x13 machined grid, 1 px gunmetal seams, cell intensity as cyan
  luminance on black, selected cell with a chrome edge, hover plate with the
  hands count.
- Positional radar: a holographic ring on black, seat markers as LED dots,
  the player's shape as a 1.5 px cyan outline with a 10% fill.
- Tables (sessions, tournaments, rake): ledger rows, 1 px seams, no zebra
  fill, right-aligned tabular figures, sortable headers in the label face.
- Trophy Room: a medallion grid; each trophy a plate with the rarity render,
  the name, the unlock rule, a progress seam; locked slots use the locked
  render and say what unlocks them.
- Buttons: compact, black-glass centre, 1 px chrome edge, blue seam on
  primary; the print and share buttons are secondary.
- Empty and error plates: the idle render, one sentence, one action.
- Live pill: the only 999 px radius on the page; a 6 px LED dot with a slow
  pulse (`data-motion="keep"`).

### 7.7 Motion (inside the Animation Law)

Entrances via the existing framer-motion setup; the live seam pulse; the EV
line draws once per load; reduced motion collapses transforms, keeps the
seam state change. Nothing new may be togglable off; speed follows
`--animation-speed`.

### 7.8 Mobile (375 px first)

Order: nav rail (horizontally scrollable, selected segment scrolled into
view) -> hero copy -> hero render crop -> live plate -> section header ->
one-column instrument grid. Touch targets 44 px. Render detail is reduced
before information. Verify on a real phone at 375 and 390, and at 768.

### 7.9 Print dossier

Paper, not the room: white ground, chrome rules become 0.5 pt grey rules,
renders print as small header strips, charts in dark ink, page break per
tab, cover block. The room is for the screen.

### 7.10 Asset pipeline

1. Generate each render at 2x the target, with the composition in 7.3 and
   the registry axes stated in the prompt.
2. Convert to WebP, resize to 3x the measured render box, through
   `scripts/optimize-arena-images.sh` (add the new entries to its table with
   the measured boxes).
3. Add the registry row. Add the `<img>` with width and height attributes,
   `alt` that describes the object (not the data), `loading="lazy"` on plates.
4. Screenshot at 375 / 768 / 1280 in a real browser against the published
   build and attach to the PR.

### 7.11 Laws that constrain this work

The hamburger menu is untouched (CLAUDE.md 10.7). Em dashes are forbidden in
player-facing text. Every static word is Title Cased. Animations always play
(10.6.1). No auto tab switching (10.6.2). No emoji in source. Horses are
players in every number shown (10.5). Popups only through the Toast layer.

---

## 8. Phases (Dan, 2026-09-04: build them out one at a time, fully, before the next)

One phase is one pull request. A phase is not finished until everything in
it is built, wired, tested locally (vitest, tsc, build), proven against
production data where it touches the database, written up in its own
`docs/changelog/` file, and pushed. Then stop (CLAUDE.md 1.1, 10.8.3) and
report; the next phase starts on a fresh branch off `main`.

| Phase | Scope                                                                                                                                                           | Status                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1     | Data foundation: 1.1 measured and closed, facts function split (10x on ranges), witness audit + `ca_stats_health()`, engine monitor + alerts + rules, 1.3, 1.14 | DONE 2026-09-04, `fix/stats-phase-1-positions` |
| 2     | Section 3: dead code out, `PlayerStatsPage.tsx` split into one lazy chunk per tab, inline colours out; 1.2 repair readout + hand-write re-measure               | next                                           |
| 3     | 1.4 EV coverage, 1.5 tournament finishes live, 1.6 session rule into the RPC, 1.15 time zone                                                                    |                                                |
| 4     | 1.7 field percentiles rollup, 1.8 transfers-equal-settlement pin, 1.13 horses sweep, section 6 conservation + horses laws                                       |                                                |
| 5     | 1.9 trophy persistence + unlock toast, 1.10 rake pagination, 1.16 PLO grid                                                                                      |                                                |
| 6     | Visual foundation: 7.3 renders #1 + #15, 7.4 tokens, 7.5 type, 7.6 nav rail + hero + section header bar, 6 visual law                                           |                                                |
| 7     | Visual: Overview, Performance, Positions tiles + charts, plates #2-#4                                                                                           |                                                |
| 8     | Visual: Hands, Tournaments, Analysis, plates #5-#7                                                                                                              |                                                |
| 9     | Visual: Trophies medallions #9-#13, Rake plate #8, share card #14                                                                                               |                                                |
| 10    | 1.12 club-staff member view on the shared components, 1.11 privacy matrix                                                                                       |                                                |
| 11    | 7.8 mobile pass, 7.9 print dossier, section 4 deep links + a11y, section 5 measurements, 9 definition of done                                                   |                                                |

Phases 6 to 9 read the `smarter-casino-realism` skill in full first and hand
it to every subagent.

---

## 9. Definition of done for the programme

- Every number on every tab is the engine's number (settlement rows), live
  within one second of the hand, in the player's range and time zone, with
  its sample size beside it; horses counted everywhere.
- Every panel has a working state, an empty state, an error state with Try
  Again, a print form and a text alternative.
- The page at 375, 768 and 1280 px passes the 7.1 quality test in a real
  browser against the published build, reviewed against the Marketplace
  screenshots side by side; it reads as the intelligence deck of the same
  machine.
- All laws in section 6 exist on `origin/main` with rows in `docs/LAWS.md`.
- `curl -s https://smarter.poker/hub/club-arena/build-info.json` reports the
  squash commit of the last PR in section 8.
