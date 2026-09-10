# Two guards that were looking slightly to the left of the thing they guard

2026-09-09. Both of these were found by finishing the table-art work rather than
by a failure, and both have the same shape as the fault that started it: the
measurement was near the defect without being on it.

## 1. `Post-Deploy E2E (production)` had failed 24 times in 21 hours and nothing said so

It is the only suite that looks at the LIVE site after a publish - routes,
layout, touch targets, an authenticated cashier, a real disconnect and reconnect
on a live table. It is not in the ruleset, so a red run blocks no merge and
colours nothing anyone reads. That is exactly the case
`scripts/ci/check-main-is-green.mjs` was written for, it runs every 15 minutes
in `publish-watchdog.yml`, and it had never once named this workflow.

### Why it could not see it

```js
const latest = list[0];
if (latest.conclusion !== 'failure') continue;
```

The run list is fetched with `status=completed`, and **completed includes
`skipped` and `cancelled`**. Its own green line said the quiet part out loud:

> OK - every workflow's latest run on main is green or neutral.

Neutral was being counted as health. Post-Deploy E2E is a `workflow_run`
listener with a concurrency group, so most of its runs end `skipped` (the
publish it listens for concluded something other than success) or `cancelled` (a
newer run took the lock). Measured over a 300-run window: **46 runs, 7 of which
carried a verdict, and all 7 were failures** - while the newest run, the only one
the detector read, was `cancelled`.

This is not a tuning problem. Any workflow that interleaves no-ops with failures
is structurally invisible to "is the newest run a failure", and an event-driven
workflow interleaves by construction. The consecutive-failure walk had the same
hole one line lower: it `break`s on any non-failure, so a single skip between two
failures reset the clock to zero and filed a day-old outage as a fresh transient.

### The rule

Only a run that reached a VERDICT is evidence. `success` says green;
`failure`, `timed_out` and `startup_failure` say red - the last two were also
invisible, because only the literal string `failure` counted.
`skipped`, `cancelled`, `neutral`, `action_required` and `stale` say nothing and
are stepped over rather than believed. A workflow with no verdict in the window
is still not an alarm: no evidence is a question, and this detector does not page
on questions.

`scripts/ci/lib/workflowVerdicts.mjs` holds the classification as pure functions
so it can be tested without the network, which the inline version could not be.

### Measured before and after, against live `main`

Exactly one workflow changes classification. No alarm burst:

|        | reported red                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| before | Schema Manifest Refresh, Estate Integrity, Cron Health, Applied Migrations Are Recorded                     |
| after  | the same four, **plus Post-Deploy E2E (production)** - `7 consecutive failed verdict(s) over at least 4.4h` |

The duration says "at least" when every verdict in the window is bad, because a
noisy workflow fills its own window - 46 of 300 here - so the oldest failure
visible is usually not the first one. It under-reports rather than claiming a
number the evidence does not carry.

**The 24 failures themselves are real and are not fixed here**: stalled tables
reported by `/health`, three customization/mission specs timing out at 60s, a
union route rendering neither the forge nor its prerequisite, and a
`Could Not Load Your Daily Bonus` console error on a critical page. They belong
to the surfaces they name. What this change does is make them arrive somewhere.

## 2. A Studio thumbnail could outlive the art it was made from

The picker does not show the table skin. It shows a 320px WebP derivative, and
generation is append-only on purpose: an existing derivative is rewritten only by
an explicit `--force` authoring run, so shipped bytes are bytes a human looked
at. That decision is right and it stays.

Its cost is that repairing a skin and forgetting the authoring run leaves the
picker showing the old picture - and `skin_classic_green` had a hole in its gold
line and `arctic_white` painted its table 19px off centre until yesterday. All
45 derivatives were checked and **none is stale today**. Nothing could have told
us that.

### It cannot be caught by looking at the pixels, and that was measured

Every committed thumbnail was compared against a fresh regeneration, and against
a regeneration of the pre-repair art:

|                                   | worst 16x16 block                    |
| --------------------------------- | ------------------------------------ |
| same art, different libvips build | up to **37.7** (`golden_sand`)       |
| genuinely stale art               | as low as **17.7** (`classic_green`) |

The bands overlap, and the wrong way round. A repaired gold line is a small local
change; an encoder version bump is a broad faint one. On the mean it inverts
harder still: stale `classic_green` scored 0.54 mean absolute difference while a
perfectly correct `golden_sand` scored 1.82. Nine of fourteen table thumbs and
all thirty-one backgrounds are byte-identical to a fresh regeneration; the other
five differ only because they were encoded by a different libvips.

So the output is not measured at all. Each derivative records the **sha256 of the
input** it was made from, in `src/assets/customization-thumbs/sources.json`. That
is exact, costs nothing, and does not care which libvips produced the bytes -
the same content-addressing `optimize-dist-media.mjs` already uses, for the same
reason.

### What changed, and what deliberately did not

- The generator records a source hash for every derivative it writes, and seeds
  an entry for an already-correct one **without touching a pixel**. Seeding all
  45 reported `generated=0 skipped=45`; a second run is a no-op. The build stays
  hermetic.
- `shouldGenerateCustomizationThumbnail` is unchanged. An ordinary production
  build still never rewrites a committed derivative. Regenerating tracked art
  inside the publisher would trade a visible fault for an invisible one.
- The gate is `tests/a-thumbnail-is-not-allowed-to-outlive-its-art.test.ts`, in
  the required unit job, so a stale thumbnail is stopped at review rather than
  discovered by a player. Verified red against the pre-repair `classic_green` -
  the subtlest of the four, and the one no pixel metric could separate - and it
  names the file and prints the one command that fixes it.
