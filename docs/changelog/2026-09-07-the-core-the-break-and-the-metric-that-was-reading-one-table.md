# The core, the break, and the metric that was reading one table

**2026-09-07.** Four defects, found from three notifications Dan forwarded and
one live CPU profile. They are unrelated in code and share one shape: in every
one of them a signal that looked healthy was measuring something other than
what it claimed to measure.

---

## 1. `/metrics` reported ONE table and called it the platform

`GameServer.getPrometheusMetrics()` called `getPrometheusMetrics()` on every
table engine and concatenated the results, stripping only `#` comment lines.
Each engine's exposition carries fourteen **global** gauges with no
distinguishing label, so a fleet of 272 engines emitted 272 samples of the same
timeseries in a single scrape. Prometheus keeps the last and drops the rest.

Measured on production, with 272 tables dealing and the fleet at ~27,000 hands
an hour:

| query                     | answered | the truth                          |
| ------------------------- | -------- | ---------------------------------- |
| `poker_active_tables`     | 1        | 272                                |
| `poker_active_players`    | 6        | one table's seats                  |
| `poker_hands_dealt_total` | 100      | one table's ring buffer, saturated |

`poker_hands_dealt_total` is declared `# TYPE counter` and was computed as
`tableTimings.length` — a ring buffer capped at 100. Every dealing table reaches
100 within a couple of minutes and then never moves again, so
`increase(poker_hands_dealt_total[5m])` is **0 forever on a healthy engine**.

Both fleet alarms written on these names were therefore dead or lying:

- **`EngineHandsStopped` / `EngineNoHandsDealt`** — `sum(increase(...)) == 0`
  against a pinned gauge. It had been firing continuously for over three hours
  while the fleet dealt normally. CLAUDE.md 10.84: an alarm that is always on is
  an alarm that gets muted.
- **`EngineFleetShrank`** — `poker_active_tables < 0.5 * avg_over_time(...)`
  compares 1 with 1 and can never fire. It is the alarm that should have caught
  04:05 UTC this morning, when the fleet lost about 80% of its throughput for
  two hours and paged nobody.

**Fixed.** `EngineTelemetry.renderFleetMetrics()` aggregates the fleet and emits
each global exactly once (counts sum, averages are weighted by the tables they
average over, p95s take the max, uptime takes the max); per-table lines all
carry `table_id`. `handsRecorded` is a real monotonic counter, kept separately
from the ring buffer, which is still what the _rate_ is computed from.
Pinned by `server/src/engine/oneSeriesPerMetricName.law.test.ts`.

## 2. The 19:00 break "did not pass". It dealt zero hands.

The push read _"Maintenance Break At 19:00 Did Not Pass. Hands In Window 366"_.
Per-minute counts across the fleet:

```
18:49   514 hands / 290 tables    normal
18:53    23 /  23                 ramp down
18:54   (no rows)                 329 dealing tables, all parked
18:55   (no rows)
18:56   (no rows)
18:57   (no rows)
18:58   (no rows)
18:59   366 / 183                 ALL 366, in one minute
19:00    66 /  66
```

Five consecutive minutes of literally zero hands platform-wide. The freeze
worked. What it did was **end 71 seconds early**:
`engine_maintenance_break_log` recorded 18:53:48.433 → 18:58:49.531 against a
countdown every player could see pointing at 19:00.

**Cause.** An out-of-band `workflow_dispatch` deploy at 18:54:14 restarted the
engine across the `:53` announcement instead of inside the `:55` countdown. The
new process adopted the persisted `last_hand` row, which carries no
`breakEndsAt`, and `restoreFromStore()` fell through to a full five minutes
measured from `this.now()` — the adopting process's **boot instant**. Every
other timer in that file is wall-clock anchored; `msUntilNextAnnouncement` is
scrupulous about it. This was the one path that was not.

**A second, latent defect in the same function.** For a `last_hand` row
`remaining` was the _constant_ `BREAK_DURATION_MS`, so the `remaining <= 1000`
staleness check above it could never fire. An orphaned announcement from any
earlier hour would be adopted by any engine booting at any later time and would
freeze the entire platform for five minutes from that boot.

**Fixed.** An adopted `last_hand` break ends at the next `:00`, whatever time
the process booted; a row older than the whole announcement-plus-break span is
refused and cleared; a `counting_down` row keeps the end instant the previous
engine already computed, because clamping _that_ to `:00` would resume early for
the same reason the bug did. Pinned by
`server/src/maintenance/anAdoptedBreakEndsOnTheHour.law.test.ts`.

## 3. The scorecard measured five minutes that were not the break

`fn_ca_record_break_scorecard` counted hands over a hardcoded
`[hour − 5 min, hour)` window and never read `break_started_at` /
`break_ended_at` — despite already selecting that row three statements later for
the gate columns. For a break that ran 18:53:48 → 18:58:48 that window overlaps
the real break by about 3:12 and contains 71 seconds of correctly-resumed play.

So the _number_ was right and the _sentence_ was false, which is worse than a
wrong number: it sent whoever read it looking for a dealing gate that had never
failed. Note also that `unparked_at_countdown = 0, peak_unparked = 0,
ready_for_restart_at = NULL, gate_opened = false` on that row is the fingerprint
of the **adoption path** (`restoreFromStore` never calls `beginCountdown`), not
evidence that the gate failed.

**Fixed** by migration `20260907163100`: hands are counted over the break that
actually ran, and whether the break covered `:55 → :00` is now its own
assertion with its own name. `detail` records the window measured and why the
verdict was reached; the push says which fault it found rather than asserting a
hand count. The verdict keeps the exact single-`CASE` shape
`tests/the-break-clocks-agree.law.test.ts` pins — the fourth clause is added
beside the three it guards, not in place of them. `v_covered IS NOT FALSE`,
deliberately: NULL means no break log row was found, and unmeasured is not
failed.

Applied, and the historical row is corrected forward:

|                         | before                              | after                           |
| ----------------------- | ----------------------------------- | ------------------------------- |
| `hands_in_window`       | 366                                 | **0**                           |
| `verdict`               | fail                                | fail                            |
| reason                  | _(implied: dealt inside the break)_ | `break_missed_its_window`       |
| measured window         | 18:55:00 → 19:00:00                 | **18:53:48.433 → 18:58:49.531** |
| `resumed_early_seconds` | —                                   | **70.47**                       |

The migration asserts that outcome and aborts if the board has moved. It did
abort on the first apply — `v_reasons || 'literal'` resolves to the
array-concat operator and fails at runtime — and nothing was committed. That is
what the assertion is for.

## 4. The governor had run out of travel

**This is the second governor fix today and it is not the same one.** Earlier
on 2026-09-07 the histogram-blindness defect was found and fixed: an empty
`monitorEventLoopDelay` histogram returns 0.000511 ms, `scaleForLoopDelay` read
that as enormous headroom, and because the histogram only records when the loop
TURNS it collected fewer samples the more saturated the loop was. The governor
stood down precisely when it was needed, which is why nothing shed load through
the 04:05 collapse. That work is written up in the note in
`EquityLoadGovernor.ts` and it is what got the fleet back to ~27,000 hands an
hour by 06:00.

What follows is what became visible **once the governor could see**: its bottom
tier is not deep enough for the fleet it is now governing.

A 20-second CPU profile of the live engine container, taken this afternoon with
the blindness fix already shipped and the governor correctly reporting 0.2:

```
34.15%  scoreHoldem          HorseEval
12.38%  scoreOmahaHi         HorseEval
 5.41%  (garbage collector)
 4.15%  simulateEquity       HorseEval
 4.07%  (idle)
 3.59%  placeOmahaBandCombo
```

62% of the single main thread in horse hand evaluation, 4% idle, with the
`EquityLoadGovernor` pinned at 0.2 — its floor — and having been there for 335
seconds. p50 event-loop delay 1,660 ms. Against the 2026-09-04 profile that
built the governor (54.4% / 18.1% / **0.3%** idle) it is plainly working; it has
run out of range, because the load it governs has grown roughly fivefold and its
bottom tier has not moved.

At that delay the consequences stop being "sluggish": `table-socket-probe`
logged `handshake_timeout` on 8 of 11 runs in the 04:00 hour against a 15-second
budget, one log window held 1,160 `FORCED state: timer_running -> waiting`
against 299 hands, and `poker_avg_hand_duration_ms` read 25,000–58,000.

**Two fixes.**

1. **A deeper tier.** `p50 >= 1000 ms` → scale `0.08`, with a lower iteration
   floor of 30, because the floor is what binds: `governedIterations(220, 0.2)`
   is already 60, so returning 60 again at 0.08 would be no change at all.
   Scales 1, 0.6 and 0.35 and the 60-iteration floor above the deep tier are
   byte for byte unchanged.

2. **The banded-Omaha floor may no longer outrank the governor.**
   `simulateEquity` ran `Math.max(120, ...)` _after_ `governedIterations`, so on
   a saturated loop it raised the banded-Omaha sample back to **double** the
   governor's floor — on the most expensive path in the profile, for the variant
   that was 52% of the fleet's hands that day. The comment fourteen lines above
   it already claimed "the governor's floor is the governor's floor"; now it is.
   The V13 floor still applies at full precision, where it buys precision out of
   headroom the engine actually has.

**Not fixed here, and it is the structural one.** The engine is one Node thread.
`docker stats` shows the container at 142% of a **3-core** box with load average
1.47 — roughly one and a half cores idle while the thread that deals every hand
is saturated. Shedding Monte Carlo precision is a brake, not capacity. The real
options are a worker-thread pool for `scoreHoldem` / `scoreOmahaHi` /
`simulateEquity` (pure functions over primitives, the easiest possible offload)
or a second engine instance — the leader election, the instance lease and the
`reverse_proxy localhost:8080 localhost:8081` in `auto-deploy-hetzner.yml` are
already there. That is Dan's call because it costs money or a sizeable refactor,
and it should be made with these numbers in front of it.

---

### Also worth knowing

`EngineCoreOutOfHeadroom`, `EngineCoreSaturated` and
`EngineSheddingPrecisionForHours` (added 2026-09-04) are correct and were firing
throughout. The core-saturation story was being told properly; it is the _fleet_
metrics in §1 that were not.
