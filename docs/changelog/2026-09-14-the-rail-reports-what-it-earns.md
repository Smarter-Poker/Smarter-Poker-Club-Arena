# The Rail Reports What It Costs And What It Earns

**2026-09-14** — Phase 5 of the ticker programme. Four changes, and the thread
running through all of them is that a notification bar lives on the same main
thread as a live poker table and had never been measured on either axis: what it
costs to keep on screen, or what any of it earns.

---

## 1. Eight sources, no data

The rail carries eight sources — overlays, starting soon, registration closing,
guarantees, table openings, winner results, maintenance, custom messages — each
with its own operator switch. Nothing had ever measured any of them. "Is the
guarantees source worth its pixels" had no answer, so every decision about the
bar's content since it was built has been taste.

**New:** `ca_ticker_usage_daily` and `fn_record_ticker_usage(jsonb)`
(`supabase/migrations/20260914095526_the_rail_reports_which_source_earns_its_pixels.sql`),
plus `src/services/TickerTelemetry.ts`.

Three counters per source per player per day:

| counter     | means                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `shown`     | an announcement OWNED THE BAR — once per announcement per tab, not once per poll and not once per render |
| `opened`    | the player pressed it and went to the event                                                              |
| `dismissed` | the player closed it                                                                                     |

Two of those make the ratio that matters. A source with impressions and no opens
is spending the most valuable pixels on the platform to say nothing; a source
with a high dismiss rate is one players are actively pushing away.

Shape notes, all deliberate:

- **A daily rollup, not events.** An impression happens whenever a tournament is
  inside its last call, on every seated player. A row per impression would
  out-write `hand_history` for a number only ever read as a ratio. Same shape as
  `ca_card_slide_usage_daily`, for the same reason.
- **Batched, at most once a minute per tab**, flushed on `visibilitychange` and
  `pagehide` so a closing tab does not lose its minute.
- **Counters are additive** (`ON CONFLICT DO UPDATE SET shown = u.shown + …`). A
  retry double-counts at worst, which is the right failure for a product signal;
  losing the day is not.
- **`SECURITY DEFINER`, pinned to `auth.uid()` inside.** A caller cannot write a
  count against anybody else, and there is no `SELECT` policy for
  `authenticated` at all — another player's reading habits are not theirs to
  read.
- **An unknown source key is ignored, not raised.** A client one deploy ahead of
  the database must never throw inside a fire-and-forget metric on a felt.
- **Every error swallowed** in the client service. A telemetry failure that
  surfaces is worse than no telemetry.

The migration carries its own verification: it records two batches as a real
authenticated user, asserts the unknown key was ignored and the counters added,
then deletes the probe row. If any of that is untrue the transaction rolls back
and nothing lands.

The plpgsql was rehearsed in `pg_temp` against production before this shipped —
no public DDL, no foreign keys, nothing touching a hot relation, per the
production DDL policy's own carve-out. The loop skipped an unknown source, a
non-object entry and an all-zero entry, and the second batch added to the first.

## 2. A dismissal is a dismissal on every table

`tickerDismissals.ts` moved from `sessionStorage` to `localStorage`
(`ca_ticker_dismissed_v3`, importing any surviving `v2`), and the container now
subscribes to the native `storage` event via `onDismissedElsewhere`.

Players on this platform multi-table. Closing an announcement on one felt used
to leave it sitting on every other one, and lose it entirely on reload.

## 3. The strip stopped re-rendering itself sixty times a minute

The container held `now` in state and advanced it every second. Every tick re-ran
the lane memo, re-rendered `TickerRail` and rebuilt every field of every
announcement — to change four characters of a countdown.

**New:** `src/components/tournament/TickerClock.tsx`. The clock is the only thing
on the strip that changes at 1Hz, so the clock is now the only thing that
re-renders at 1Hz. React updates one text node and nothing above it moves. It
counts to an INSTANT rather than a duration, so a tab that slept for ten minutes
wakes up showing the right number instead of one that drifted, and it clears its
own interval at zero rather than counting into negatives on a bar nobody is
reading.

Both of the container's own loops now run at `CONTAINER_TICK_MS` (5s):

- the **expiry tick**, which only has to retire announcements and feed the spoken
  line — and the spoken line is rounded to the MINUTE precisely so a screen
  reader is not told the news sixty times a minute;
- the **toast sweep**, which rendered nothing and so survived the first pass: it
  walked every announcement once a second, for every registered player, to catch
  two thresholds that are not exact and never were. Its late-arrival guards
  (`sLeft > 120`, `sLeft > 10`) were written for a backgrounded tab and already
  tolerate far more than four seconds.

`tests/unit/tickerCostPerMinute.test.ts` pins all of this structurally, because a
behavioural test cannot see the difference between "renders correctly" and
"renders correctly sixty times a minute" — which is exactly why it regressed
silently for as long as it did.

Also removed: `LEAD_MS`, dead since the lead window became `leadMsFor(buyIn)` and
sitting next to its replacement reading like a second opinion.

## 4. The chime, finally — and narrow on purpose

The audit promised a chime for the overlay announcement and four phases shipped
without one. That was the right order: a sound is the easiest thing on this strip
to get wrong. A bar that beeps is a bar that gets muted, and a player who mutes
the app to silence an advertisement also mutes their own turn alert. The cost of
a bad chime is not annoyance — it is a player timing out on a hand.

**New:** `SoundService.playRailAlert()` and `tickerChime.ts`.

The tone is deliberately unlike every other cue in `SoundService`. Every `play*`
above it means something happened to YOUR hand, YOUR chips or YOUR turn; this one
means a strip at the top of the screen has an announcement on it. So it is built
to be ignorable: `ui` priority (rank 10, the lowest that still has one, so a
fold, an all in or a pot sweep landing in the same frame wins and this is
dropped), a quiet rising fourth around G4–C5 at about a quarter of the turn
bell's gain, and no haptic. It must never be mistaken for "it is on you", which
is the one confusion that would actually cost a player money.

And the gate is four rules, each with a test:

1. **Only overlays.** An overlay guarantee is the one announcement on this rail
   worth money to the player. Everything else stays silent.
2. **Once per announcement, per tab.** The lane recomputes on every poll; the
   event worth hearing is the ARRIVAL.
3. **Never the first strip a tab shows.** Arriving on a page that immediately
   beeps at you is not news.
4. **The player's switch wins,** asked BEFORE playing, so a muted tab never wakes
   an AudioContext on the ticker's account.

The memory lives in module scope, not in the component, because the container
unmounts on every navigation and a per-component memory would chime again on each
one.

---

## Verified

- `tsc --noEmit` clean; ESLint clean on every touched file (0 errors).
- `check:title-case` and `check:painted-text` both OK.
- Full suite, 4 shards: **20,353 tests — 20,351 passed, 1 skipped, 1 red**.
  That red —
  `engine-release-seal.law.test.ts` — is `ModuleNotFoundError: No module named
'tomllib'` on this machine's Python 3.9.6 (`tomllib` is 3.11+), and fails
  identically on a pristine `origin/main` worktree with none of this applied.
- New tests: `tickerClock.test.tsx` (9), `tickerChime.test.ts` (19),
  `tickerCostPerMinute.test.ts` (12), `tickerTelemetry.test.ts` (18), plus the
  dismissal suite retargeted to `localStorage`/v3.
