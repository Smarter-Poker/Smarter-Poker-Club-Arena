# Stats Page Full Buildout Plan

Target surface: `https://smarter.poker/hub/club-arena/stats`
Source page: `src/pages/PlayerStatsPage.tsx` (1694 lines, rebuilt 2026-08-19)
Author: Cowork agent session, 2026-08-21
Status: PLAN. Tier 3 (architecture). Nothing built yet.

This plan covers all eight requested features:

1. EV vs Actual Profit chart (the "luck" graph)
2. Interactive 13x13 hole card heatmap
3. Nemesis and Target tracking
4. Radar / spider chart for positional awareness
5. Framer Motion animation migration
6. PDF "Dossier" report export
7. Gamified Trophy Room and playstyle badges
8. Percentile benchmarking against the field

---

## 0. Read this first: the four findings that reshape the plan

A full audit of production Supabase (`kuklfnapbkmacvwxktbh`) and the engine
source was run before writing this. Four facts dominate every design decision
below. None of them are guesses; each was verified against live data.

### 0.1 `hand_history` is purged after 7 days

`sp_prune_hand_history(p_batch)` deletes hands older than `interval '7 days'`.
Live check: `min(created_at) = 2026-08-14 15:00:02`, `max = 2026-08-21 15:03:02`.
The table holds ~1,537,000 rows and **10,155 MB**, growing ~238k rows/day.

The prune is supposed to spare hands with humans in them via the `has_human`
column. **`has_human` is NULL on 100% of rows** - nothing has ever set it. So
today the purge deletes human hands too.

Consequence: **every feature that needs per-hand detail (EV, hole cards,
head-to-head chip flow) cannot be derived retroactively.** A durable
per-player-per-hand fact row must be written at settlement time, or the data is
gone on day 8. This is Phase 1 and it blocks features 1, 2, 3 and 8.

### 0.2 All-in equity is already computed, then thrown away

`server/src/engine/ServerTableEngineRunout.ts` line ~1022,
`broadcastAllInEquity(allInPlayers, board, pot)`, calls
`getEquityPool().estimateEquity(...)`. Because every hand is known at an all-in,
this is **exact all-in equity**, not an estimate against a random range. The
number is sent to the client over WebSocket and observed into a Prometheus
histogram (`poker_all_in_equity_duration_ms`). It is never persisted. Grep for a
Supabase write anywhere in that code path returns nothing.

`allInForOffer[].atRisk` (line ~1194) already holds the exact chips at risk.

Consequence: **the EV graph needs no new math.** It needs two lines of plumbing
to carry an existing in-memory value into the settlement write. This is the
single highest value-per-effort item in the whole plan.

### 0.3 Hole cards exist for only 32.5% of hands, by design

`hand_history.hole_cards` is a JSONB object keyed by userId, populated
**exclusively from `params.showdownResults`** in
`server/src/services/supabase/handHistory.ts` (~lines 95-110). Mucked cards are
deliberately never stored - a stated game-integrity decision. `players[].cards`
is `[]` on 20,000 of 20,000 sampled rows and is useless.

Consequence: a heatmap built on today's data would only show **hands that
reached showdown**, which is a wildly biased sample - it would make every hand
class look far more profitable and far more played than it is. The heatmap
requires the engine to write the hero's own hole cards to their own private fact
row for **every** hand dealt. That is not a security regression: a player is
already entitled to see their own cards, and the row is protected by RLS scoped
to `auth.uid()`.

### 0.4 There is exactly one human player in the entire database

585 users have hands. 584 of them are horses (`profiles.is_horse = true`). The
one human is `47965354-0e56-43ef-931c-ddaab82af765` (`kingfish`, "Marcus Chen")
with **422 hands**. Median hands per user across all 585 is 19,628 - that number
is entirely horses.

Consequence for feature 8: **percentile benchmarking against other humans is not
possible and will not be possible until the club has real traffic.** Two honest
options exist, covered in Section 9. Benchmarking against the horse field is
viable today and is arguably the more useful comparison anyway, since the horses
are the field a player actually faces - but the UI copy must say so plainly and
must never imply a human population that does not exist.

### 0.5 What already exists and should be reused, not rebuilt

- **A radar chart already exists**: `src/components/stats/PlayerStyleRadar.tsx`
  (432 lines, hand-rolled SVG). It is wired into `ProfilePage.tsx:984` and is
  **not on the stats page**. It plots six derived axes (Aggression, Tightness,
  Position, Win Rate, Showdown, Bluff Freq) - not the per-position VPIP/PFR/3bet
  breakdown that feature 4 calls for. It reads `session_history` and
  `player_position_stats` on **percent scale**, whereas the stats page RPC
  returns **fractions 0..1**. Reuse the SVG rendering approach, replace the axes.
- **`framer-motion@^11.18.0` is already a dependency**, used in exactly 9 files,
  all in `src/components/common/` (Modal, Notification, Dropdown, Tooltip,
  Search, Button, Card, Tabs, Progress). Zero usage in `src/pages/` or
  `src/components/stats/`. Note `src/lib/index.ts:10` records that a shared
  `lib/animations.ts` variants module was deliberately deleted on 2026-08-19.
- **An achievements system already exists and is populated**:
  `src/services/AchievementService.ts` (singleton `achievementService`, canonical
  `ACHIEVEMENTS: Achievement[]`), backed by `training_user_achievements` (67
  rows), rendered by `src/components/achievements/AchievementBadge.tsx` (exports
  `AchievementBadge` and `AchievementGrid`, CSS modules,
  `RARITY_COLORS = { common:'#9ca3af', rare:'#3b82f6', epic:'#a855f7', legendary:'#fbbf24' }`).
  There is also `src/components/achievements/AchievementShareCard.tsx` which
  renders a 600x400 PNG to a `<canvas>` - a working precedent for visual export
  with no new dependency.
- **`src/services/PlayerStyleClassifier.ts`** already classifies a player into
  `'shark'|'fish'|'rock'|'maniac'|'tag'|'lag'|'nit'|'calling_station'` with a
  label, icon, colour and confidence. Feature 7's playstyle badges are largely a
  presentation layer over this existing service.
- **`src/components/stats/PlayerStatsDashboard.tsx` (315 lines) is dead code**
  seeded with hardcoded fake numbers (`vpip: 24.5, totalHands: 15420`). Nothing
  imports it. It contains the repo's only recharts `RadarChart` usage. Delete it
  in Phase 6 rather than let it be mistaken for a starting point.
- **`.stats-fade-in` in `PlayerStatsPage.css:459-467` is dead CSS** - declared,
  never applied in any TSX. The real stagger is
  `PlayerStatsPage.css:1028-1075` (`@keyframes statRowIn` plus hardcoded
  `:nth-child(1)`-`:nth-child(8)` delays, so only the first 8 rows animate).
- **No PDF library exists.** `src/lib/export.ts` has `exportSettlementPDF()` and
  `exportHandHistoryPDF()`, but `htmlToPdfBlob()` returns
  `new Blob([html], { type: 'text/html' })` and triggers `window.print()`. Its
  own comment says "actual PDF generation would use jsPDF". Feature 6 needs a
  real decision, not an extension of this.

### 0.6 The one-paragraph version of the strategy

Build **one durable, human-only, per-player-per-hand fact table** written by the
engine at settlement. It is the single dependency for features 1, 2, 3 and 8.
Ship the two zero-data-dependency features (radar, Framer Motion) first so the
page visibly improves in week 1 while the fact table accumulates history. Then
ship the data features in order of how quickly they become meaningful. Trophy
Room and the PDF dossier come last because they are presentation layers over
everything before them.

---

## 1. Phase 1: The durable fact layer (blocks features 1, 2, 3, 8)

**Estimated effort: 3-4 days. This is the critical path. Nothing else data-driven ships without it.**

### 1.1 Why a new table rather than extending `hand_history`

`hand_history` is 10 GB and grows 238k rows/day, 99.97% of it horse-versus-horse
traffic that no human will ever look at. Adding columns to it multiplies that
cost and does nothing about the 7-day purge.

The fact table writes **one row per human seat per hand**. At today's volume that
is 422 rows/week. At 10,000 human hands/day with 6 humans per table it is ~22M
rows/year at roughly 250 bytes - about 5.5 GB/year, and that is a wildly
pessimistic ceiling the club is nowhere near. It can be retained indefinitely.

Horses get no fact rows. Their aggregate contribution to benchmarking comes from
`player_position_stats` (already populated, 13.9M hands, 584 users) via a nightly
rollup - see Section 9.

### 1.2 Migration: `supabase/migrations/20260822_ca_hand_facts.sql`

Written from the `supabase/migrations/.template.sql` skeleton per
`.agent/workflows/migration-safety.md`. This is Tier 2 (new objects only, no
DROP, no ALTER COLUMN TYPE), so it needs the pre-flight checklist and post-apply
assertions but not a pasted ROLLBACK section.

```sql
create table if not exists public.ca_hand_facts (
  hand_id          uuid        not null,
  user_id          uuid        not null,
  club_id          uuid,
  table_id         uuid,
  tournament_id    uuid,
  played_at        timestamptz not null,
  game_variant     text        not null,
  big_blind        numeric     not null,

  -- seating and position (from button_seat, authoritative, not action order)
  seat             smallint,
  position         text        not null,   -- BTN SB BB UTG UTG1 MP LJ HJ CO
  players_dealt    smallint    not null,

  -- the hero's own cards, EVERY hand, RLS-protected to auth.uid()
  hole_cards       jsonb,                  -- [{"rank":"A","suit":"spades"},...]
  hand_class       text,                   -- 169-grid key: 'AA','AKs','72o'; NULL for PLO

  -- money. exact. INCLUDES blinds and antes.
  invested         numeric     not null,
  returned         numeric     not null,
  net              numeric     not null,
  net_bb           numeric     not null,
  rake_paid        numeric     not null default 0,

  -- flow flags, computed in engine where the truth lives
  vpip                  boolean not null default false,
  pfr                   boolean not null default false,
  three_bet             boolean not null default false,
  faced_three_bet       boolean not null default false,
  folded_to_three_bet   boolean not null default false,
  had_cbet_flop_opp     boolean not null default false,
  cbet_flop             boolean not null default false,
  saw_flop              boolean not null default false,
  went_to_showdown      boolean not null default false,
  won_at_showdown       boolean not null default false,
  aggressive_actions    smallint not null default 0,
  passive_actions       smallint not null default 0,

  -- all-in EV. NULL when the hand had no all-in involving this player.
  was_all_in       boolean     not null default false,
  all_in_street    text,                   -- preflop flop turn river
  all_in_at_risk   numeric,                -- chips at risk at the moment of the all-in
  all_in_equity    numeric,                -- 0..1, exact enumeration from the equity pool
  ev_returned      numeric,                -- equity-weighted expected return of the all-in pot
  ev_net           numeric     not null,   -- = (ev_returned - invested) when all-in, else = net
  ev_net_bb        numeric     not null,

  created_at       timestamptz not null default now(),
  primary key (hand_id, user_id)
);

create index if not exists idx_ca_hand_facts_user_time
  on public.ca_hand_facts (user_id, played_at desc);
create index if not exists idx_ca_hand_facts_user_class
  on public.ca_hand_facts (user_id, hand_class) where hand_class is not null;
create index if not exists idx_ca_hand_facts_user_pos
  on public.ca_hand_facts (user_id, position);

alter table public.ca_hand_facts enable row level security;

create policy ca_hand_facts_own_read on public.ca_hand_facts
  for select to authenticated using (user_id = auth.uid());
-- writes are service_role only; the engine holds SUPABASE_SERVICE_ROLE_KEY
```

**RLS is load-bearing here.** `hole_cards` on this table includes cards that
never went to showdown. The `for select ... using (user_id = auth.uid())` policy
is the only thing preventing a player from reading an opponent's mucked hand.
Any RPC that reads this table for anyone other than the caller must be
`SECURITY DEFINER` and must never return `hole_cards` or `hand_class` for a
`user_id` other than the caller. This is an explicit review gate on every PR in
Phases 2-9.

### 1.3 Migration: `supabase/migrations/20260822_ca_hand_transfers.sql`

Nemesis needs head-to-head chip flow, which is **not derivable from stored data**
(confirmed in audit: `hand_players.chips_won`/`chips_lost` is exactly the right
shape and has 0 rows; deriving from `winners[].amount` gives "opponent's gross
winnings in hands I was in", which in a multiway pot attributes another loser's
money to the hero).

```sql
create table if not exists public.ca_hand_transfers (
  hand_id    uuid        not null,
  winner_id  uuid        not null,
  loser_id   uuid        not null,
  amount     numeric     not null check (amount > 0),
  played_at  timestamptz not null,
  club_id    uuid,
  primary key (hand_id, winner_id, loser_id)
);

create index if not exists idx_ca_hand_transfers_loser
  on public.ca_hand_transfers (loser_id, played_at desc);
create index if not exists idx_ca_hand_transfers_winner
  on public.ca_hand_transfers (winner_id, played_at desc);

alter table public.ca_hand_transfers enable row level security;
create policy ca_hand_transfers_involved_read on public.ca_hand_transfers
  for select to authenticated
  using (winner_id = auth.uid() or loser_id = auth.uid());
```

**Attribution rule (exact, decided here so it is not re-litigated later):** for
each pot, each winner receives, from each losing contributor to that pot, an
amount proportional to that loser's contribution to that specific pot. The engine
knows per-pot eligibility and per-player contribution at settlement, so this is
exact - no estimation. Side pots are handled naturally because each pot is
attributed independently. Rake is deducted from the pot before attribution, so
transfers sum to the winners' net awards.

A row is written only when **at least one** of winner/loser is human. Horse-only
transfers are discarded.

### 1.4 Engine changes

Four files. All in `server/src/`, deployed to Hetzner automatically by
`.github/workflows/auto-deploy-hetzner.yml` on any push to `main` touching
`server/**`.

**a. `server/src/engine/ServerTableEngineRunout.ts`** - capture the equity that
is already being computed.

- In `broadcastAllInEquity()` (~line 1022), after `estimateEquity(...)` resolves,
  persist the result onto a per-hand map on the engine instance:
  `this.currentHandAllInEquity.set(userId, { equity, street, atRisk })`.
  `atRisk` comes from the existing `allInForOffer[].atRisk` (~line 1194), which
  is `p.totalInvested`.
- If multiple all-in points occur in one hand (rare but legal - a player all-in
  preflop, more action on the flop between deeper stacks), record the **first**
  all-in point for each player, which is the moment their stack was committed.
  Document this choice in the code comment; it is the convention every tracker
  uses.
- Clear the map on hand start.

**b. `server/src/engine/HandController.ts`** - at `showdownResults` construction
(~line 1303), also produce a per-player fact record for every player dealt in,
not only those who reached showdown. The controller already holds every input:
`totalInvested` per player (includes blinds and antes, which is exactly why we
use it and not the `actions` JSON), per-street action history, button seat, seat
order, pot structure and eligibility.

Compute in the engine, not in SQL:

- `position` from `button_seat` and seat order (same offset math
  `ca_player_stats_full` already uses, so the two agree).
- `hand_class` for NLH/short-deck: rank pair sorted high-low, plus `s`/`o`
  suffix, pairs get neither. `NULL` for PLO variants (a 13x13 grid is
  meaningless for 4-6 card hands - see 3.4).
- the flow booleans, from action history rather than re-parsed JSON.
- `ev_returned`: when the player was all-in, `equity * (pot they were eligible
for, after rake)`. When not all-in, `ev_net = net` so the EV series and the
  actual series stay identical outside all-in spots, which is the correct
  behaviour for a luck graph.
- the pot-proportional transfer list.

**c. `server/src/services/supabase/handHistory.ts`** - add
`insertHandFacts(facts, transfers)` alongside `insertHandHistoryRow()`, reusing
the existing bounded retry queue (`MAX_QUEUE=2000`, `MAX_QUEUE_BYTES=24MB`,
`MAX_QUEUE_ATTEMPTS=20`). Two separate PostgREST inserts, both idempotent on
their primary keys via `on_conflict` do-nothing, so a retry after a partial
failure is safe.

Filter to humans before writing. The engine already knows which seats are horses.

**d. Same file - fix `has_human`.** Set `has_human: true` on the `hand_history`
row whenever any seat is a human. This is a one-line change, it is what the
column was added for, and it makes `sp_prune_hand_history` spare human hands as
originally designed. Independently valuable regardless of this plan.

### 1.5 Backfill

**There is no backfill.** Hole cards for non-showdown hands and all-in equity
have never been stored, so nothing exists to backfill from. `ca_hand_facts`
starts empty and accumulates from deploy forward.

This is the single most important scheduling fact in the plan and it drives the
phase order: **features 1, 2 and 3 need roughly two weeks of accumulated play
before they display anything worth looking at.** Ship the UI for them behind a
"needs more hands" empty state, and let the data arrive.

Partial mitigation for feature 3 only: a one-off approximate nemesis backfill
from the 7 days of `hand_history` currently on disk is possible using
`winners[].amount` over shared hands. It is **not chip-accurate** for multiway
pots. Recommendation: skip it. A wrong nemesis is worse than a "still gathering
data" card.

### 1.6 Aggregate rollups

Reading 22M fact rows per page view is not acceptable. Two rollups, refreshed by
the existing Open Claw dispatcher (`scripts/openclaw-cron-dispatcher.py` in the
World Hub repo - **not** `vercel.json`, per World Hub CLAUDE.md section 11):

```sql
-- 169-grid aggregate, one row per (user, hand_class, variant)
create table public.ca_player_class_agg (
  user_id uuid, hand_class text, game_variant text,
  hands int, hands_vpip int, hands_won int,
  net_bb numeric, ev_net_bb numeric,
  updated_at timestamptz default now(),
  primary key (user_id, hand_class, game_variant)
);

-- head-to-head aggregate, one row per (user, opponent)
create table public.ca_player_h2h_agg (
  user_id uuid, opponent_id uuid,
  hands_together int, net_from_opponent numeric,
  last_played_at timestamptz,
  updated_at timestamptz default now(),
  primary key (user_id, opponent_id)
);
```

New handler `pages/api/cron/ca-stats-rollup.js` in the **World Hub** repo,
checking `Authorization: Bearer $CRON_SECRET`, using
`src/lib/supabaseServerClient.js`. Registered in
`scripts/openclaw-cron-dispatcher.py` at `*/15`, then deployed with
`bash scripts/deploy-openclaw.sh`. Note the repo file and the Hetzner file must
never drift - the audit found the dispatcher had silently drifted 6 jobs behind
because `deploy-openclaw.sh` pointed at an SSH key that was never created. Watch
one fire cycle in `journalctl -u openclaw` before calling it shipped.

Incremental by `played_at > last_rollup_watermark`, using a state row in the same
style as `ca_hand_player_idx_state`.

### 1.7 Phase 1 acceptance criteria

- A human plays 20 hands at a live table. `select count(*) from ca_hand_facts
where user_id = <them>` returns 20.
- `hole_cards` is non-null on all 20, including hands they folded preflop.
- At least one all-in hand has `all_in_equity` strictly between 0 and 1 and
  `ev_net <> net`.
- `sum(net)` across the 20 rows equals the player's actual chip delta at the
  table, to the cent. This is the test that catches blind and ante omission,
  which is the specific bug that makes every derived-from-`actions` number in
  the current system wrong.
- `select sum(amount) from ca_hand_transfers where hand_id = X` equals the total
  awarded to winners in that hand, minus rake.
- A second authenticated user querying `ca_hand_facts` for the first user's rows
  gets zero rows back (RLS proof).
- `has_human = true` on the corresponding `hand_history` rows, and those rows
  survive the next `sp_prune_hand_history` run.

---

## 2. Phase 2: EV vs Actual Profit chart (the luck graph)

**Depends on Phase 1. Effort: 1 day of build, plus ~2 weeks of data accumulation before it is meaningful.**

### 2.1 What it plots

Two cumulative series over the same x-axis (hand index or date, toggleable):

- **Actual**: running `sum(net_bb)`.
- **All-in Adjusted EV**: running `sum(ev_net_bb)`.

The gap between them is the entire point. `Actual > EV` means running above
expectation. `Actual < EV` means running below it. A shaded band between the two
lines, green when actual is on top and red when it is underneath, communicates
this faster than any legend.

### 2.2 RPC

`supabase/migrations/20260823_ca_player_ev_curve.sql`

```sql
create or replace function public.ca_player_ev_curve(
  p_user uuid,
  p_days int default null,
  p_bucket text default 'hand'   -- 'hand' | 'day'
) returns jsonb
language sql security definer stable as $$
  ...
$$;
grant execute on function public.ca_player_ev_curve(uuid,int,text)
  to authenticated, service_role;
```

Returns
`{ points: [{ i, at, net_bb, ev_net_bb, cum_net_bb, cum_ev_net_bb }], summary: { hands, all_in_hands, luck_bb, luck_bb_per_100, biggest_suckout, biggest_beat } }`.

**Security note:** `SECURITY DEFINER` bypasses RLS, so the function body must
begin by asserting `p_user = auth.uid()` unless the caller is `service_role`.
Without that assertion this RPC leaks one player's results to another. Same
assertion is required in every RPC in Sections 3, 4 and 8.

Cap at the most recent 5,000 hands. Note the existing `ca_player_stats_full`
caps at 750 because `authenticated` runs with `statement_timeout = 8s` and it
parses JSONB on the fly; reading pre-computed numeric columns off an indexed
table is orders of magnitude cheaper, so a much higher cap is safe here. Verify
with `explain analyze` before settling on 5,000.

### 2.3 Component

`src/components/stats/EVLuckChart.tsx` + `EVLuckChart.css`

recharts `ComposedChart` with two `<Line>` and an `<Area>` for the delta band,
`ResponsiveContainer`, matching the styling of the existing `AreaChart` in the
Analysis tab (gradient id pattern `profitGradient`, so use `evGradient` /
`luckGradient` to avoid an SVG id collision - recharts gradient ids are global to
the document and two charts sharing one silently render the wrong fill).

Props: `{ userId: string; initialData?: EVCurvePayload }`, matching the
`initialX` convention every other stats component uses so the page can pass
server data down and skip a fetch.

Header stat strip above the chart: "Running **+12.4 bb/100** above expectation
over 2,340 hands", plus an explicit all-in-hand count so the player can see the
sample the adjustment rests on.

### 2.4 Empty and low-sample states

- Zero all-in hands: the two lines are identical by construction. Show the chart
  with a single line and a note: "No all-in hands yet. Once you get it in, this
  chart will show how you ran."
- Fewer than 30 all-in hands: render, but with a persistent caption that all-in
  EV is high-variance and 30 spots tells you very little. Do not hide the chart;
  do not present it without the caveat.

### 2.5 Placement

New **Luck** sub-section at the top of the existing **Performance** tab, above
the Preflop group. It is a performance stat, and the Analysis tab is already the
heaviest on the page.

---

## 3. Phase 3: Interactive 13x13 hole card heatmap

**Depends on Phase 1. Effort: 2 days build, plus data accumulation.**

### 3.1 The sample-size problem, stated up front

169 cells. A player with 2,000 hands has, on average, **12 hands per cell** - and
that average is deeply misleading because the distribution is not uniform: `72o`
appears about as often as `AA`, roughly 0.45% of hands each, while any given
suited connector is rarer still. At 2,000 hands a typical cell has single-digit
observations and its bb/100 is pure noise.

A naive green/red profitability heatmap over that data will confidently tell the
player that `J4o` is their most profitable hand. That is not a leak-finding tool,
it is a random number generator with a colour ramp. Designing around this is the
main work of this phase, not the grid rendering.

### 3.2 The design that survives small samples

Three view modes on one grid, defaulting to the one that is meaningful earliest:

1. **Frequency (default)** - how often the player voluntarily played each hand
   class. This is statistically stable at a few hundred hands because it is a
   rate over opportunities, not a sum of high-variance outcomes. It is also the
   view that actually reveals leaks: a grid showing the player opening `K7o` from
   UTG is a real, immediately actionable finding.
2. **Profit (bb/100)** - the green/red view. **Cells below a confidence
   threshold render desaturated grey with a dot count**, not a colour. Threshold:
   30 hands per cell. Above it, colour saturation scales with sample size as
   well as with magnitude, so a 35-hand cell is visibly paler than a 300-hand
   cell.
3. **Luck (actual minus EV)** - only available once Phase 2 data exists. Shows
   which hand classes the player has run well or badly with. Explicitly labelled
   as variance, not skill, so it is not mistaken for a strategy signal.

Filters above the grid: position (All / BTN / CO / MP / UTG / SB / BB), variant,
and time range reusing the page's existing `RANGES` array.

### 3.3 Interaction

Hovering a cell shows a tooltip: hand class, hands dealt, times played (VPIP %),
net bb, bb/100, and the EV delta when available. Clicking a cell drills into the
notable hands list for that class, reusing the existing `ca_player_hands` pattern
and the page's existing `formatCard()` renderer (which already converts
`"8hearts"` to `8♥`).

Rendering: **SVG or CSS grid, not recharts.** 169 cells with hover state is not
a chart-library problem. A CSS grid of 169 `<button>` elements is simplest,
keyboard-accessible for free, and mobile-friendly. At 375px width (mobile-first
is a binding working rule) each cell is about 26px - tight but tappable, and the
grid should be horizontally scrollable inside its own container below ~360px
rather than shrinking further.

### 3.4 PLO

`hand_class` is `NULL` for `plo4` / `plo5` / `plo6`. A 169-cell grid cannot
represent a 4-to-6-card starting hand. When the variant filter is set to a PLO
game, replace the grid with a categorical breakdown (double-suited, single-suited,
rainbow; connected / gapped; pair-containing) which is the standard PLO
equivalent. Scope this as a **Phase 3b follow-up**, not part of the initial
build. The initial build renders the grid for NLH and short-deck and shows an
explanatory card for PLO.

### 3.5 Data path

Reads `ca_player_class_agg` (Section 1.6) via a new RPC
`ca_player_hand_grid(p_user uuid, p_position text, p_variant text, p_days int)`
returning a 169-entry array. One indexed read, no JSONB parsing. Target under
150ms.

### 3.6 Component

`src/components/stats/HoleCardHeatmap.tsx` + `.css`. New **Hands** tab on the
page, since it is too large to nest inside an existing tab. Requires adding
`'hands'` to `StatCategory`, `BASE_TABS` and `TAB_LABELS` - and note the swipe
handler (`useSwipeTabs`) picks up new tabs automatically from the `TABS` array,
so no separate change there.

---

## 4. Phase 4: Nemesis and Target tracking

**Depends on Phase 1 (`ca_hand_transfers`). Effort: 1.5 days.**

### 4.1 What it shows

A card with two halves:

- **Your Nemesis** - the opponent with the largest net chip flow _from_ the
  player _to_ them.
- **Your Target** - the largest net flow the other way.

Each side shows avatar, username, net chips (and bb), hands played together, and
a "last met" timestamp. Below, a ranked table of the top 10 in each direction.

### 4.2 Data path

`ca_player_h2h_agg` (Section 1.6), which stores signed `net_from_opponent`.
Nemesis is `order by net_from_opponent asc limit 1`, Target is `desc`.

RPC `ca_player_nemesis(p_user uuid, p_days int, p_min_hands int default 25)`
joins `profiles` for `username`, `avatar_url`, `is_horse`.

### 4.3 Two decisions that need to be made explicitly

**Horses.** Right now essentially every opponent is a horse. If horses are
excluded, the feature displays nothing for the foreseeable future. If they are
included, a player's nemesis will be named "boardTexture" or "Mia Dahlström"
and the social dynamic the feature is meant to create does not exist yet.

Recommendation: **include horses, and do not visually distinguish them.** They
are named, persistent opponents with real personalities, and "Steeltrap has taken
14,200 chips off you" is an engaging line whether or not the player knows what
is behind it. Never call them bots (binding working rule). Revisit when the human
population is large enough that human-only is viable, and consider a "Humans
only" toggle at that point rather than a hard filter now.

**Minimum sample.** Below ~25 shared hands a "nemesis" is one big pot, not a
rivalry. Enforce `p_min_hands = 25` and show "Not enough hands yet" rather than
crowning someone off a single cooler.

### 4.4 Placement and component

`src/components/stats/NemesisPanel.tsx` + `.css`, placed on the **Overview** tab
below the existing `.stats-grid`. It is a headline, socially engaging stat and
Overview is where a player looks first.

Clicking an opponent navigates to `/stats/:userId` - a route that **already
exists** (`App.tsx:998`) and already renders the same page for another user.
Confirm that route's behaviour respects privacy for the new tabs: the heatmap
and EV chart must **not** render for `!isOwnProfile`, since they expose hole
cards and results. `isOwnProfile` is already computed on the page; gate the new
tabs on it.

---

## 5. Phase 5: Positional radar chart

**No new data required. Effort: 1 day. Ship this in week 1.**

### 5.1 What exists versus what is asked for

`PlayerStyleRadar.tsx` plots six _derived personality_ axes and lives on
ProfilePage. Feature 4 asks for something different: **VPIP, PFR and 3-Bet
plotted across positions**, so the shape of the web reveals positional
imbalance - a web that bulges at UTG and pinches at BTN is a player with the
fundamentals backwards.

### 5.2 Design

Axes are the **seven positions** already returned by `ca_player_stats_full`:
`UTG, UTG+1, MP, CO, BTN, SB, BB` (confirmed live in the audit output). Three
overlaid polygons, one per metric, each with its own colour and a toggle to show
or hide it:

- VPIP (blue)
- PFR (green)
- 3-Bet (amber)

Each metric normalises against its own sensible maximum (VPIP 60%, PFR 40%,
3-Bet 15%) so the three polygons are comparable on one radius. Show the raw
percentages on the axis labels so the normalisation never has to be explained.

Overlay a dashed reference polygon showing a **healthy positional shape** - VPIP
rising monotonically from UTG to BTN. This is what turns the chart from a data
display into a coaching tool: the player sees their web against the shape it
should be.

### 5.3 Data

`full.positions` is **already loaded** on the page and already passed into
`PositionWinRates`. Zero new queries. `PositionRow` gives
`{ position, hands_played, vpip_count, pfr_count, three_bet_count, hands_won, total_profit, bb100 }`,
so all three metrics are counts over `hands_played`.

Watch the scale trap: `ca_player_stats_full` returns **fractions 0..1** while
`player_position_stats` (used by `PlayerStyleRadar`) is **percent-scaled**. The
new component takes counts and divides, so it sidesteps both. Do not copy
normalisation code from `PlayerStyleRadar` without re-checking scale.

### 5.4 Component

`src/components/stats/PositionalRadar.tsx` + `.css`. Hand-rolled SVG following
the `PlayerStyleRadar` structure (`viewBox="0 0 240 240"`, `CX=120 CY=120 R=90`,
rings at `[0.25, 0.5, 0.75, 1.0]`), which is proven on this codebase and avoids
pulling recharts' `RadarChart` in for one use. Reuse its class-name conventions
but with a distinct prefix to avoid CSS collisions if both ever render on one
page.

Props `{ positions: PositionRow[]; loading?: boolean }` - pure presentation, no
fetching, which makes it trivially testable.

Placement: top of the **Positions** tab, above the existing `PositionWinRates`.
Low-sample guard: grey out any position axis with fewer than 30 hands and note
it in the legend. At 422 hands the current human has `UTG+1: 10 hands` and
`CO: 39` - exactly the case this guard is for.

---

## 6. Phase 6: Framer Motion migration

**No data dependency. Effort: 1.5 days. Ship in week 1 alongside Phase 5.**

### 6.1 Scope

Replace the page's CSS-keyframe animation with `framer-motion`, which is already
a dependency and already used in nine `src/components/common/` primitives.

Targets:

- **Tab transitions.** Wrap `.stats-content` in `<AnimatePresence mode="wait">`
  keyed on `category`, with a short fade-and-slide. This is the change the player
  will feel most, because they switch tabs constantly.
- **Staggered card reveals.** Replace the hardcoded `:nth-child(1)`-`(8)` delays
  at `PlayerStatsPage.css:1028-1075` with a parent `variants` container using
  `staggerChildren`. The current CSS only animates the first eight rows; the
  Performance tab has more than eight and the rest appear instantly, which is
  visibly inconsistent today.
- **Layout animation** on the hero when the range selector changes and the
  numbers reflow, via `layout` on the hero stat tiles.
- **Chart entrance** springs for the new EV chart, heatmap and radar.

### 6.2 Do not break

- **`prefers-reduced-motion`.** A block already exists near
  `PlayerStatsPage.css:1250` with `animation: none !important`, which will not
  affect framer-motion's JS-driven transforms. Use framer-motion's
  `useReducedMotion()` hook and collapse every variant to instant. This is an
  accessibility requirement, not a nicety, and it is the most likely thing to be
  missed.
- **The count-up animations.** `useCountUpNumber` (local to the page) and
  `AnimatedNumber` (in `AdvancedStatsSummary`) are rAF-based and independent of
  framer-motion. Leave them alone; do not attempt to convert them to
  `useMotionValue` in the same PR.
- **Swipe tabs.** `useSwipeTabs` attaches handlers to `.stats-content`. Wrapping
  that element in `AnimatePresence` must not swallow the touch handlers - spread
  `{...statsSwipeHandlers}` onto the `motion.div`, not onto a new outer wrapper.
- **Bundle size.** framer-motion is already in the bundle via the common
  primitives, so this adds nothing. Confirm with `npm run analyze` regardless.

### 6.3 Shared variants module

`src/lib/index.ts:10` records that `lib/animations.ts` was **deliberately
deleted** on 2026-08-19 in favour of framer-motion. Do not resurrect that file.
Put the stats-page variants in
`src/components/stats/statsMotion.ts` - scoped to this feature, exporting
`fadeUp`, `staggerContainer`, `tabTransition`, `chartReveal`. If a second page
later wants them, promote deliberately rather than pre-emptively creating a
global module that was already rejected once.

### 6.4 Cleanup in the same PR

- Delete `src/components/stats/PlayerStatsDashboard.tsx` and
  `PlayerStatsDashboard.css` (dead code, fake seeded numbers, nothing imports it).
- Delete the dead `.stats-fade-in` rules at `PlayerStatsPage.css:459-467`.
- Add the large stats components to `src/components/stats/index.ts`, which
  currently barrel-exports only `StatCard` and `StatGrid`.

---

## 7. Phase 7: Trophy Room and playstyle badges

**Depends on Phases 1-5 for the interesting criteria. Effort: 3 days.**

### 7.1 Reuse, do not rebuild

The audit found a complete, working achievements stack:
`achievementService` + canonical `ACHIEVEMENTS` array + `training_user_achievements`
(67 rows) + `AchievementBadge` / `AchievementGrid` (CSS modules, rarity colours)

- `AchievementShareCard` (canvas PNG export) + `ConfettiEffect` + `StreakFire` +
  `AchievementNotification`.

Three known friction points to resolve first, in a small preparatory PR:

1. **Two divergent type definitions.** `AchievementsPage.tsx` declares its own
   local `Achievement` interface and its own
   `AchievementCategory = 'all'|'poker'|'social'|'financial'|'tournament'`, while
   `AchievementService.ts` declares
   `'hands'|'wins'|'social'|'financial'|'special'|'tournament'`. The page even
   carries a comment that "IDs MUST match AchievementService.ts exactly", which
   is a convention held together by hope. Unify on the service's types and have
   the page import them.
2. **`progress` is absolute in the DB** and converted to a 0-100 percentage only
   inside the page. The Trophy Room must not re-derive that conversion
   independently. Move it into the service as
   `getProgressPercent(userId, achievementId)`.
3. **The silent circuit breaker.** `AchievementServiceClass` has a
   `_dbReadDisabled` flag that permanently returns `[]` for the rest of the
   session after the first read error (missing table or RLS denial). A Trophy
   Room that depends on this will show an empty room with no error and no
   retry. Replace the silent breaker with a bounded retry plus a surfaced error
   state, or the first RLS hiccup produces a bug report that is impossible to
   diagnose.

### 7.2 Playstyle badges

`playerStyleClassifier.classify({ handsPlayed, vpipCount, pfrCount, threeBetCount, ... })`
already returns `{ style, label, icon, color, bgColor, confidence, tooltip }`
across `shark | fish | rock | maniac | tag | lag | nit | calling_station`. That
covers the Rock and Maniac examples directly.

Work needed:

- Feed it from `full.overall` (fractions) rather than the percent-scaled session
  tables, and convert once at the boundary.
- Honour `confidence` in the UI: below a threshold, show "Style forming" with a
  hands-remaining counter instead of a possibly-wrong label. Assigning someone
  "Maniac" off 80 hands is both wrong and insulting.
- Add a **style history strip** - the badge over the last 6 months from
  `player_stats_snapshots` (28,044 rows, the only stats history that survives the
  7-day purge). Watching yourself move from Fish to TAG over months is the most
  motivating thing this feature can show, and the data is already there.

### 7.3 Milestone achievements

New definitions appended to the canonical `ACHIEVEMENTS` array. Grouped:

- **Volume**: Ironman (10,000 hands), Grinder (1,000), Marathon (8h single
  session), Century (100 sessions).
- **Results**: Shark (won 100 buy-ins), Comeback (recover from -50bb to positive
  in one session), Crusher (positive bb/100 over 5,000+ hands).
- **Hands** (needs Phase 1): Royalty (make a royal flush), Quad Squad (four of a
  kind), Set Miner (win a 50bb+ pot with a small pocket pair).
- **Discipline** (needs Phase 1): Ice Cold (fold AA to a river raise and be
  right), Bluff Catcher (win at showdown with ace-high).
- **Luck** (needs Phase 2): Rundown (finish a month 20+ bb/100 below EV and keep
  playing) - deliberately rewards resilience through variance rather than
  results, which is the healthier thing to gamify.

Progress evaluation runs in the **existing** `ca-stats-rollup` cron handler from
Section 1.6, not in a browser. Client-side achievement granting is trivially
forgeable and would need its own RLS story; server-side it needs none.

### 7.4 Placement

New **Trophy Room** tab, added to `StatCategory` / `BASE_TABS` / `TAB_LABELS`.
Contents: playstyle badge hero with the history strip, then `AchievementGrid`
filtered to poker categories, then a "next up" strip showing the three
achievements closest to completion (which is the section that actually drives
return visits).

Do **not** duplicate the existing `/achievements` page. Trophy Room shows the
poker-performance subset; add a "See all achievements" link out to the existing
page. Two pages showing overlapping achievement sets with different type
definitions is exactly the drift already documented in 7.1.

---

## 8. Phase 8: Percentile benchmarking

**Depends on Phase 1 for hero-side stats. Effort: 2 days. Blocked on an honesty decision, see 8.1.**

### 8.1 The decision that has to be made before this is built

There is **one human with hands** in the entire database. Any percentile computed
today is a percentile against horses.

Three options:

**Option A - benchmark against the field, labelled honestly.** Compute
percentiles over all `player_stats` / `player_position_stats` rows (587 users,
13.9M hands, statistically clean). Label it in the UI as "the field" or
"all players at your stakes" - never "human players", never a bare "Top 5%" with
no referent. **Recommended.** It ships now, the comparison is genuinely useful
because those are the opponents actually being faced, and it is not misleading
provided the copy is precise.

**Option B - human-only, gated.** Compute over `is_horse = false` users only, and
show the whole section only once the cohort exceeds a minimum (suggest 50 users
with 1,000+ hands each). Honest, but the feature is invisible for months and the
code rots untested.

**Option C - build both.** Ship A now with a cohort selector that is locked to
"Field" until the human cohort clears the threshold, then unlocks. More work, but
the transition is a switch flip rather than a rebuild.

Recommendation: **A now, structured so C is a later config change** - i.e. put a
`cohort` parameter in the RPC from day one and hardcode the caller to `'field'`.

### 8.2 Data path

Nightly rollup into a distribution table, refreshed by the same
`ca-stats-rollup` handler:

```sql
create table public.ca_stat_distribution (
  cohort      text not null,        -- 'field' | 'human'
  stake_band  text not null,        -- 'micro' | 'low' | 'mid' | 'high' | 'all'
  metric      text not null,        -- vpip pfr three_bet fold_to_three_bet bb100 wtsd af
  p10 numeric, p25 numeric, p50 numeric, p75 numeric, p90 numeric,
  sample_size int not null,
  computed_at timestamptz not null default now(),
  primary key (cohort, stake_band, metric)
);
```

Percentiles via `percentile_cont` over the cohort, with a `min_hands` qualifier
(use 1,000, well above `fn_global_leaderboard_period`'s `v_min_hands := 20`,
because rate stats need far more hands to stabilise than volume stats do).

Client-side placement of the hero's value into that distribution needs no extra
round trip: ship the five breakpoints with the stats payload and interpolate.

### 8.3 UI

Not a new tab. **Inline on the existing `StatRow` component.** Each stat gains an
optional percentile pill and a thin distribution bar showing where the player
sits between p10 and p90.

Crucially, **direction matters and is not uniform**. High VPIP is not "good".
Neither is low. Each metric needs a `goodness` descriptor:

- `higher_better`: bb/100, PFR (within range)
- `lower_better`: fold to 3-bet
- `band_optimal`: VPIP, WTSD, aggression factor - where both tails are leaks and
  the target is a middle band

For `band_optimal` metrics, do not show a percentile at all. Show position
relative to the healthy band: "Your VPIP of 42% is above the profitable range
(18-28%)". A "Top 5% VPIP" badge would be actively harmful coaching.

The user's example - "You fold to 3-bets 75% of the time (Bottom 20%, easily
exploitable)" - is exactly right in tone and should be the template: number,
percentile, and the _consequence_. Keep the consequence text short and factual.

### 8.4 Existing infrastructure worth reusing

`fn_user_rank_global_period(p_user_id, p_metric, p_period) → jsonb` already
returns a user's rank and `total_ranked` - a percentile falls straight out of
rank/N. Use it for the volume and winnings metrics it already covers rather than
recomputing them, and add `ca_stat_distribution` only for the rate stats it does
not.

---

## 9. Phase 9: PDF Dossier report

**Depends on Phases 2-8 (it renders their output). Effort: 2-3 days.**

### 9.1 There is no PDF capability today

`src/lib/export.ts` `htmlToPdfBlob()` returns
`new Blob([html], { type: 'text/html' })` with a comment admitting it. Both
`exportSettlementPDF()` and `exportHandHistoryPDF()` are print-dialog wrappers,
not PDF generators. A real dossier is a new capability.

### 9.2 Three approaches

**A. Client-side `jspdf` + `html2canvas`.** Adds ~400KB gzipped to the bundle.
Charts render as rasterised images, so text in them is not selectable and looks
soft on retina. Simplest to build. Bundle cost is the real objection - this is a
mobile-first product and 400KB for a rarely-used export is a bad trade.

**B. Client-side `pdf-lib` with hand-laid-out vector content.** ~150KB, produces
genuinely crisp vector output, but every chart has to be re-drawn in PDF
primitives. Highest quality, most work, and the charts would drift from their
on-screen versions over time.

**C. Server-side render (recommended).** A new endpoint on the Hetzner engine or
a World Hub API route that renders the dossier HTML with headless Chrome and
returns a real PDF. **Zero client bundle cost.** Charts render exactly as they do
on screen because it is the same HTML and CSS. The dossier template can be far
richer than anything squeezed into a client bundle.

Costs of C, stated plainly: a headless Chrome dependency on the server, a new
authenticated endpoint, and a cold-start latency of a few seconds. Mitigate with
a "generating your dossier" state and an emailed or downloaded result. Note the
engine already accepts authenticated POSTs from this page - `sendToAssistant()`
posts to `${VITE_ENGINE_URL}/assistant/leaks/detect` with the Supabase access
token - so the auth pattern is established and copyable.

**Recommendation: C.** Revisit A only if adding headless Chrome to the engine
box proves operationally painful.

### 9.3 Interim option with zero dependencies

`AchievementShareCard.tsx` already renders a 600x400 PNG via `<canvas>` and
downloads it. The same technique produces a **shareable stats card** - hero
numbers, playstyle badge, a small sparkline - in a day, with no new dependency
and no server work. It is not a dossier, but it is the thing players will
actually post, and it can ship in week 1 while the real PDF is scoped.

Strong recommendation: build the share card early regardless of which PDF path
is chosen.

### 9.4 Dossier contents

Cover page (username, avatar, date range, headline bb/100 and hands), then:
overview stats table, EV vs actual chart, positional radar, hole card heatmap,
nemesis and target, percentile benchmark table, notable hands, and a
plain-language leaks summary. The leaks section can call the **existing**
`/assistant/leaks/detect` engine endpoint rather than writing new analysis.

Replace the current `exportOverviewCSV` / `exportSessionsCSV` buttons with an
export menu offering CSV (keep both existing options unchanged), PNG share card,
and PDF dossier.

---

## 10. Sequencing

The ordering is driven by one fact: **the fact table has no backfill**, so
features 1, 2 and 3 are data-starved for their first two weeks no matter when
they are built. Therefore build the data plumbing first so the clock starts,
ship visible no-data-required wins immediately after, and land the data features
as their data matures.

| Week | Ships                                                                     | Visible to players?                           |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | Phase 1 (fact layer, engine writes, `has_human` fix)                      | No - invisible plumbing, but starts the clock |
| 1    | Phase 5 (positional radar), Phase 6 (Framer Motion), 9.3 (PNG share card) | Yes - immediate, obvious improvement          |
| 2    | Phase 2 (EV chart) behind a low-sample state; Phase 8 (percentiles)       | Yes                                           |
| 3    | Phase 3 (heatmap); Phase 4 (nemesis)                                      | Yes - and by now they have ~2 weeks of data   |
| 4    | Phase 7 (Trophy Room)                                                     | Yes                                           |
| 5    | Phase 9 (PDF dossier)                                                     | Yes                                           |
| 6    | Phase 3b (PLO categorical grid), cleanup, retention review                | Partial                                       |

Total: roughly **5-6 weeks** of focused work. The critical path is Phase 1;
everything else parallelises.

---

## 11. Cross-cutting concerns

### 11.1 Privacy - the highest-risk area in this plan

`/stats/:userId` **already exists** and renders the full page for any user id. It
is a pre-existing route, and the new features change what it can expose.

Binding rules for every PR in this plan:

- `ca_hand_facts.hole_cards` contains cards that never went to showdown.
  Exposing them for another player is a game-integrity failure, not a privacy
  nicety.
- The **heatmap** and **EV chart** tabs must be hidden entirely when
  `!isOwnProfile`. `isOwnProfile` is already computed on the page.
- Every `SECURITY DEFINER` RPC touching `ca_hand_facts` must assert
  `p_user = auth.uid()` in its first statement unless the caller is
  `service_role`. `SECURITY DEFINER` bypasses RLS - the table policy will not
  save a careless RPC.
- Add an automated check: a test that authenticates as user A and asserts every
  new RPC returns empty or errors for user B's id. Run it in CI.
- Decide and document what `/stats/:userId` should show at all. A reasonable
  default: public aggregate stats (VPIP, PFR, hands, winnings) yes; hole cards,
  EV, nemesis, trophy progress no.

### 11.2 Performance budget

`authenticated` runs with `statement_timeout = 8s`, which is why
`ca_player_stats_full` caps at 750 hands. Every new RPC must be `explain analyze`d
against a user with 50,000+ fact rows (simulate by writing horse rows to a
scratch branch) before merge. Targets: heatmap grid under 150ms, EV curve under
300ms, nemesis under 100ms.

The page already fires `ca_player_stats_full` plus per-component queries from
`AdvancedStatsSummary`, `BankrollTracker`, `SessionHistory` and
`PositionWinRates`, each with its own separate localStorage SWR cache
(`ps_stats_v3_`, `adv_stats_v1_`, `bankroll_v1_`, `sess_hist_v1_`, ...). Adding
four more independent fetchers will make this worse. **Consolidate as part of
Phase 6**: one page-level fetch, one cache key, data passed down as props via the
`initialX` convention the components already support.

### 11.3 Storage and retention

`hand_history` is 10 GB at 7-day retention. This plan does not change that, and
the `has_human` fix will _slightly_ increase it by sparing human hands from the
prune - which is a few hundred rows per week today and entirely acceptable.

`ca_hand_facts` should have its own retention policy defined now, before it
exists, rather than discovered later: **retain indefinitely**, revisit at 50M
rows. `ca_hand_transfers` likewise. Add both to the prune observability that
`fn_hand_history_prune_skip_depth` provides for `hand_history`.

### 11.4 Testing

- Unit tests for the engine fact-builder: position derivation from `button_seat`
  across 2-9 handed, hand-class canonicalisation across all 169 classes, and
  pot-proportional transfer attribution with side pots. These are pure functions
  and should have full coverage.
- The `sum(net) == actual chip delta` assertion from 1.7 belongs in an
  integration test, not just a manual check. It is the test that catches the
  entire class of blind-and-ante bugs that makes the current derived stats wrong.
- Component tests via the existing `@testing-library/react` + `vitest` setup.
- Playwright E2E for the new tabs, extending the existing `tests/` suite.
- `npx tsc --noEmit` clean before every commit (binding rule, Club Arena
  CLAUDE.md section 5.6).

### 11.5 Rules compliance checklist for every PR here

From Club Arena CLAUDE.md:

- `.maybeSingle()`, never `.single()`
- No emoji anywhere in source
- Popups: Title Case, no em dashes, always through the Toast layer
  (`src/utils/popupStyle.ts`)
- Numbers via `.toLocaleString()`
- Mobile-first: design at 375px, then scale up. The 13x13 grid is the hard case.
- Never call the AI players bots. They are horses.

From World Hub CLAUDE.md:

- New cron jobs go to **Open Claw**, never `vercel.json` (CI enforces this)
- Migrations under `supabase/migrations/<YYYYMMDD>_<desc>.sql`, applied via the
  Supabase MCP `apply_migration`, never raw `execute_sql`
- Deploy via `bash scripts/sync-club-arena.sh` / `git-safe-push.sh`; only claim
  deployed on `DEPLOY_VERIFIED:true`

---

## 12. Decisions — all locked and implemented, 2026-08-21

Dan delegated every call. These are final and are reflected in the shipped code.

| #   | Decision                     | Call taken                                                                                                                                                                                                                                                                            |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Benchmark cohort             | **The field**, including horses. Labelled "the field" everywhere and never "players like you". `ca_stat_distribution.cohort` exists from day one so a human-only cohort is a config flip, not a rebuild.                                                                              |
| 2   | PDF approach                 | **Reversed during implementation.** Not server-side headless Chrome — see below. Print stylesheet + the browser's own vector PDF writer, plus a canvas PNG share card.                                                                                                                |
| 3   | Nemesis: horses?             | **Included, undistinguished.** Minimum 25 shared hands, enforced server-side. Never referred to as bots.                                                                                                                                                                              |
| 4   | `/stats/:userId` exposure    | Aggregates stay public. **Hands and Trophies tabs are owner-only**, EV chart and rivals render only for the owner, and every RPC asserts caller identity server-side.                                                                                                                 |
| 5   | `hand_history` retention     | Left at 7 days. `has_human` is now actually set, so the purge stops deleting human hands — a column that had been NULL on all 1,509,240 rows since it was added.                                                                                                                      |
| 6   | PLO heatmap                  | `hand_class` is NULL for PLO so those hands never reach the grid; the empty state explains why. Categorical PLO breakdown deferred to 3b.                                                                                                                                             |
| 7   | Transfer attribution _(new)_ | **Hand-level proportional**, not per-pot. Exact for single-pot and single-winner hands, conserves chips exactly, attributes rake to nobody. Per-pot attribution would have required editing an oversized engine file for accuracy invisible in the aggregate a nemesis stat displays. |

### 12.1 Why decision 2 was reversed

The plan recommended rendering the dossier server-side with headless Chrome.
Once it came to building it, that was the wrong call:

- **The engine box is latency-critical.** It runs live poker. Spawning Chrome
  next to it to render a report trades gameplay smoothness for a document.
- **A Vercel render function** means a cross-repo dependency, sits near the
  50MB function ceiling once chromium is bundled, and adds cold starts to
  babysit.
- **`jspdf` + `html2canvas`** is roughly 400KB of bundle on a mobile-first
  product for a rarely-used export, and rasterises every chart.

The browser already ships an excellent vector PDF writer. The page now renders
every tab at once in `printing` mode behind a single `showTab()` gate — one set
of section markup serves both the tabbed screen view and the printed report, so
there is no duplicated JSX to drift — and a real print stylesheet turns it into
ink-on-paper with per-section page breaks and no panel split across pages.
Result: selectable vector text, zero bundle cost, zero server load, and "Save
as PDF" already sits in every print dialog.

---

## 12A. What shipped on 2026-08-21

All eight requested features are built, verified and on `main`.

| Feature                    | Status  | Where                                                             |
| -------------------------- | ------- | ----------------------------------------------------------------- |
| 1. EV vs actual profit     | Shipped | `EVLuckChart.tsx`, `ca_player_ev_curve`                           |
| 2. 13x13 hole card heatmap | Shipped | `HoleCardHeatmap.tsx`, `ca_player_hand_grid`                      |
| 3. Nemesis / Target        | Shipped | `NemesisPanel.tsx`, `ca_player_nemesis`                           |
| 4. Positional radar        | Shipped | `PositionalRadar.tsx` (no new queries)                            |
| 5. Framer Motion           | Shipped | `statsMotion.ts`, tab transitions, reduced-motion respected       |
| 6. PDF dossier             | Shipped | print mode + print stylesheet, plus `StatsShareCard.tsx`          |
| 7. Trophy Room             | Shipped | `TrophyRoom.tsx`, milestones derived from live stats              |
| 8. Percentile benchmarking | Shipped | `BenchmarkPanel.tsx`, `statBenchmarks.ts`, `ca_stat_distribution` |

Supporting work:

- `ca_hand_facts` and `ca_hand_transfers` created with RLS; the engine writes
  them at settlement from values it already held and previously discarded.
- All-in equity, which `broadcastAllInEquity()` computed exactly and then threw
  away, is now captured via a two-line interception in `TableStateHub` — zero
  edits to the three oversized engine files.
- `has_human` fixed.
- `ca_refresh_stat_distribution` wired into the existing
  `club-stats-maintenance` cron rather than adding a cron file, per World Hub
  CLAUDE.md 11.3/11.5.
- `scripts/git-safe-push.sh`: its build gate had been silently disabled for
  every agent on a non-interactive shell (no `npx` on PATH → reported "Build
  failed" → pushed anyway, reason swallowed by `2>/dev/null`). Now fails closed
  on a missing toolchain and prints real build output.

Verification: 2,610 tests pass (48 new), `tsc --noEmit` clean on client and
server, `vite build` green, cross-user RPC denial proven against production,
and Hetzner engine deploy confirmed by a DB-visible behavioural change.

## 12B. Post-build audit, 2026-08-21

Two full line-by-line review passes were run over everything above. They found
**seven defects that corrupt data permanently** and a dozen correctness bugs.
All are fixed, and every one has a regression test that was verified to FAIL
against the old code.

### 12B.1 The three that mattered most

Each of these writes wrong data into `ca_hand_facts`, which is retained
indefinitely while its source (`hand_history`) is purged at 7 days. A wrong row
here is wrong forever.

1. **`rake_paid` was hardcoded `0`.** Every row claimed the player paid no
   rake, so "win rate net of rake" was permanently unanswerable. Now
   contribution-weighted, matching `atomic_distribute_rake`.
2. **`saw_flop` used a fold on _any_ street.** A player who called preflop and
   folded to a c-bet was recorded as never having seen the flop. That collapsed
   `saw_flop` into `went_to_showdown` and — worse — made `cbet%` measure only
   the c-bets that _worked_, because the ones that got raised off were excluded
   from their own denominator.
3. **`was_all_in` missed every all-in reached by calling.** The engine sets
   `is_all_in` on a stack-consuming call but records the action as `'call'`, so
   the covering player who snaps off a shove and the short stack who calls one
   both looked not-all-in. That is one whole side of most all-in confrontations
   missing from the luck graph.

### 12B.2 The rest

- `folded_to_three_bet` fired on folds to 4-bets and cold 4-bets (took two
  passes to get right: it needs _opened_, _has not already answered_, and _no
  further raise since_).
- `faced_three_bet` fired on any re-raise, inflating fold-to-3-bet.
- Transfer shares were rounded per pair, so they did not sum to what the winner
  won — drift accumulating monotonically in the Nemesis aggregate. Now
  largest-remainder, exact to the cent.
- `all_in_street` recorded the runout street, not the player's commit street.
- **Percentiles inverted below a negative breakpoint.** `bb100`'s p10 is −52.1
  in production, and the extrapolation ranked −100 bb/100 at the 19th
  percentile: the worse a player ran, the better they scored.
- **The benchmark bar contradicted its own pill.** The field is 584 horses, so
  VPIP p10 is 27.6 while the healthy band is 18-28 — a disciplined human at 24%
  got a green "In Range" pill _and_ a marker pinned under "Bottom 10%". Band
  metrics now draw no bar at all.
- **Two leak rules were unreachable.** `overall.wtsd` is showdowns over hands
  _dealt_ (~5% live), but the thresholds were written for showdowns over flops
  _seen_ (24-30%).
- **The print dossier printed white-on-white** for most of its content, and
  recharts' inline axis fills meant printed charts lost both axes. The 1s
  "safety net" also collapsed the dossier mid-preview on Safari and mobile,
  where `print()` does not block.
- The EV gap band was green whether running above _or_ below expectation.
- The playstyle classifier was fed an aggression factor of exactly 1.0 on every
  call, making shark/lag/maniac/tag literally unreachable.
- A non-positive big blind wrote `net_bb` as raw chips, silently poisoning the
  EV curve and heatmap colour scales. The hand is now refused instead.
- `ca_player_class_hands` and `ca_hand_facts.four_bet` were live in production
  with **no migration file** (RULE 2) — the schema was not reproducible from
  `supabase/migrations`. Both committed.

### 12B.3 Added after the audit

- **`LeakPanel` / `findLeaks`** — the page could say what a player's numbers
  were and nothing about what to do. Ranked, actionable findings derived purely
  from stats already loaded. Its headline rule catches _position played
  backwards_, which is invisible in a table of numbers.
- **Heatmap drill-down** — clicking a cell lists the hands behind it.
- **`four_bet`** column, because it is also unrecoverable if not captured now.

### 12B.4 Known and deliberately left

- `net` covers pot money only. Bad-beat jackpots, insurance settlements and 7-2
  bounties move chips at the same settlement and are not included; a player who
  hits a jackpot shows a large negative `net` on the hand that paid them.
  Documented at the write site.
- `had_cbet_flop_opp` counts spots where the hero was donked into, which most
  trackers exclude.
- `folds_to_3bet` and the c-bet rules are gated on hand volume rather than on
  _opportunity_ counts, which the RPC does not expose. At 1,000 hands and 8%
  PFR a player faces perhaps 15-25 three-bets.
- A 5-bet sets neither `three_bet` nor `four_bet`, matching usual tracker
  scoping.

---

### 12A.1 The one thing that is not done, and cannot be

`ca_hand_facts` has **no backfill and cannot have one** — hole cards for
non-showdown hands and all-in equity were never stored, so there is nothing to
backfill from. Features 1, 2 and 3 render honest "still gathering" empty states
until real hands accumulate. Everything else is live immediately.

---

## 13. What this plan does not do

Stated so it is not mistaken for an omission:

- No retroactive stats. Everything data-driven starts from the deploy date.
- No changes to the horse AI or `horse_opponent_journals`, despite it having the
  richest stat schema in the database (47 columns including the only `wtsd` and
  `won_at_showdown` in the schema). It is horse-to-opponent directional and not
  player-facing. Worth a separate look later as a HUD data source.
- No consolidation of the four abandoned empty stats tables (`user_poker_stats`,
  `poker_session_stats`, `user_stats`, `hand_players`). `hand_players` in
  particular has almost exactly the right shape and zero rows; it was left alone
  deliberately rather than revived, because `ca_hand_facts` needs columns it does
  not have and reviving a dead table invites confusion about which is
  authoritative. Consider dropping them in a cleanup migration.
- No change to the 750-hand cap in `ca_player_stats_full`. It exists for a real
  reason (8s statement timeout against on-the-fly JSONB parsing). Once
  `ca_hand_facts` is populated, that RPC could be rewritten to read it and the
  cap lifted entirely - a worthwhile Phase 10 that is out of scope here.
