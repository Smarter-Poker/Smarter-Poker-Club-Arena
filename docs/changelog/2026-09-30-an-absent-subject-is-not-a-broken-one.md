# An Absent Subject Is Not A Broken Subject, And A Freeze Is Not 370 Seconds

2026-09-30. Two harness defects kept `Post-Deploy E2E (production)` from ever
reaching a terminal verdict. Neither had found anything wrong with the live
site. Both are the same mistake in different clothes, and it is the one
CLAUDE.md 10.86 is about: a check answering confidently about something it was
never in a position to judge.

Three earlier causes (the provenance race, the engine's own `:55` restart read
as a 502 failure, and a publisher cancelled while still queued) are fixed and
merged; see
[`2026-09-30-the-certificate-learns-to-say-i-could-not-tell.md`](./2026-09-30-the-certificate-learns-to-say-i-could-not-tell.md).
This is the rest.

## 1. The MTT case reported a missing subject as a broken one

`Live-table and engine verification` certifies that an **already-running**
table stays realtime through a disruption and recovers exactly one owner. It
does not create that table. Production has to be running one: right format,
right fixture club, three or more dealable seats, and - for the MTT alone - a
tournament whose blind clock can still yield a natural level after recovery.

That is a precondition production cannot always supply. Run **36748751745**
is the worked example. SPIN, SNG and the cash network-loss case all passed. The
MTT case failed with

```
production exposed no already-running MTT table with 3+ dealable players in
fixture scope a41434bb.../fade0000... whose tournament can yield an eligible
natural HUD clock ... inside 90000ms
```

The fleet was demonstrably alive at the time. Nothing was wrong. The suite
simply had no name for "there was nothing to observe", so it used the only one
it had.

**Now it has one.** `tests/e2e/support/certifiableSubject.ts` classifies the
empty candidate list from the scoped health the case has just read:

- **stalled** - a table of this format, in this club, with enough dealable
  seats, a hand in progress and not parked by design, has stopped dealing. That
  is production failing in front of the certificate. It stays **red**, and the
  message now names the table, its dealable count, its idle seconds and its
  loop phase instead of printing a bare `Expected: 0 / Received: 1`.
- **absent** - no such table was running at all, or none could satisfy the
  case's own clock requirement. Nothing was observed, so nothing is certified
  **and nothing is condemned**: a named non-verdict.

The classification is deliberately conservative. `absent` requires that not one
table in scope was both in the certifiable shape and silent; the moment one is,
the verdict is `stalled`.

A non-verdict is never silence (10.86 rule 1 forbids folding "I could not tell"
into silence just as firmly as into green). `tests/e2e/support/nonVerdict.ts`
records it four ways: a `::warning::UNKNOWN:` line, a `NON-VERDICT` paragraph
in the job summary, a `non-verdict` annotation carried in the Playwright JSON
report and therefore in the artifact, and the scoped health that produced it,
attached. That is the same vocabulary
`scripts/ci/production-e2e-provenance.mjs` already uses for a superseded
release window, deliberately reused rather than invented again.

**It cannot hide a run that verified nothing.**
`scripts/ci/assert-e2e-actually-ran.mjs` fails any spec file in which every
test skipped, so a non-verdict only ever survives while its siblings in the
same file really ran.

### The fleet-wide stall assertion, and what production actually said

`readEngineHealth` also asserted `stalledTableCount === 0` and
`deadStalledCount === 0` on **every** health read. Both are **fleet-wide**
aggregates: `/health` computes them across every table the engine owns,
whatever scope the caller asked for.

The question the task set was whether that is a live defect or the normal state
of an idle fleet. It is a live defect, and it is measured, not assumed. Across
the last fourteen post-deploy runs the assertion fired **zero** times before
17:16Z today and on **every** run after it. At 17:15:58Z one MTT table in the
fixture union - `916a88ea-2f62-42b3-9b4a-f0711115af46`, the
`$100 Freeroll - 12:00 PM` event - dealt its last hand and wedged. At 18:13Z it
was still `status='running'`, eight seats occupied, eight dealable, not paused,
`loopPhase: "dealing+3269s"`, 57 minutes without a hand. That is a real
production defect. It is **not** an idle-fleet artefact, and it is not this
release.

So the aggregate is not deleted, it is scoped to what the certificate is
actually judging:

- `wholeFleetStalled` stays a hard red. If the whole fleet is dark, nothing can
  be certified.
- A read **by table id** is the subject this case selected. A stall there is a
  hard red, named.
- A read **by format** is the engine's own sample of up to 32 candidate tables
  the case has not chosen. A wedged table in there disqualifies itself as a
  candidate; if it turns out to be the reason no candidate exists at all, the
  classifier above turns it back into a red with the table named.
- Anything else is reported as an observation, deduplicated by content, naming
  every table id the engine publishes in `stalledTables`.

That last line is a deferral, not a suppression, and the reader is named
(10.86 rule 3): **`PokerTablesFrozen`** in
`infra/monitoring/engine-freeze-rules.yml` pages `severity: critical` on
`poker_stalled_tables > 0 for 1m`, with
`docs/runbooks/tables-frozen.md` behind it, and
`scripts/ci/check-alert-rules-match.mjs` refuses to be silently green about
whether that rule is loaded.

The engine had already reached this conclusion for itself. `wholeFleetStalled`
exists, in its own words, "so that one stalled table cannot condemn" the rest -
written after `poker_engine_liveness` sat at zero for **136 of 139 minutes** on
the strength of one table out of 312. The harness was making the same mistake
one layer up, and charging it to whichever release happened to be publishing.

## 2. Fixture cleanup could not outlast a freeze it always met

`scripts/ci/production-e2e-account.mjs` and
`tests/e2e/support/temporaryCustomizationAccount.ts` both handled the hourly
platform freeze (section 13) with the same blind loop: 37 attempts, ten seconds
apart. **370 seconds.**

Measured against `public.engine_maintenance_break_log`, every one of the 435
breaks from 2026-09-16 18:55Z to 2026-09-30 17:55Z:

|                          | seconds                               |
| ------------------------ | ------------------------------------- |
| minimum                  | 395                                   |
| median                   | 417                                   |
| mean                     | 448                                   |
| p95                      | 532                                   |
| p99                      | 550                                   |
| longest ordinary         | 578 (2026-09-28 15:55Z)               |
| longest observed         | 4222 (2026-09-18 17:55Z, an incident) |
| **finished inside 370s** | **0 of 435**                          |

Not sometimes. Every time. A cleanup that opened inside a freeze always ran out
of budget, and the fixture it could not delete then failed the spec's own
residue assertion.

**Raising the count is not the fix** (10.86 rule 4): the Playwright callers sit
inside a 600s/720s test timeout inside a 50-minute job, so a bigger blind
budget just fails one level up where the cause is harder to read.

`scripts/ci/platform-freeze-window.mjs` waits on the freeze's **own end
condition** instead. It reads the single row in `public.engine_maintenance_break`
for the instant the break is scheduled to end, polls `public.fn_platform_frozen()`
every five seconds, and returns the moment it says false.

**The budget is read, not guessed.** It is what the row says is left, plus the
measured tail the engine really takes past `break_ends_at` to finish thawing -
95s minimum, 139s mean, 231s p95, 278s longest ordinary, so the constant is
300s. A cleanup that opens at the very top of a freeze therefore waits at most
600s, which covers the longest ordinary freeze ever recorded; one that opens
near the end waits only what is left.

**The ceiling is the database's own.** When the row cannot be read the wait
falls back to 900s, because `fn_platform_frozen()` only honours a
counting-down row whose `break_ends_at < announced_at + INTERVAL '15 minutes'`.
Fifteen minutes is the longest freeze the database will enforce at all; waiting
past it would be waiting for something that is no longer a freeze. The 4222s
incident is deliberately out of reach of every budget here.

**An unreadable freeze is never a thaw** (10.86 rule 2). A failed read keeps
the wait running and is counted, and a wait whose every read failed returns
`unreadable`, so the caller reports UNKNOWN rather than claiming a freeze
refused it.

The three specs that own production fixtures add exactly one measured
allowance - `CLEANUP_FREEZE_ALLOWANCE_MS`, 600s - to their own timeout, and
spend it only when a freeze is actually enforced. The level above was checked:
the job allows 50 minutes and normally spends 20 to 24, and section 13
schedules one break an hour, so one teardown at most can meet one.

Both cleanups also stop looping forever: `PLATFORM_FREEZE_MAX_WAITS` is 2, one
for the hourly break and one for the extra certified recovery window the
September 17 owner update allows a corrected release. A third refusal is a
defect, not the schedule, and it says so.

## The freeze has never once fitted its documented window

Reported here and deliberately **not** acted on. Section 13 documents a
five-minute break from `:55` to `:00`. Of the 435 breaks measured, **0**
finished inside five minutes. Every break started at `:55:00` and ended
between `:01:35` and `:04:38`; the overrun past `break_ends_at` ranged from 95s
to 278s, mean 139s.

The constants are law: `tests/the-break-clocks-agree.law.test.ts` pins the `:55`
minute, the deploy's break-gate minute, the freeze ceiling and the windows
across five surfaces, and section 13 requires them to move together in one
commit. Nothing here moves any of them. The harness now measures the real
duration and waits for it; whether the engine should be finishing its thaw
faster, or the documented window should say what actually happens, is a
separate piece of work for whoever owns the thaw.

## What is pinned

- `tests/unit/certifiableSubject.test.ts` - stalled against absent, the seat
  floor, a table parked by design, another club, another format; and source
  pins that the fleet aggregates no longer condemn a release, that the fleet
  verdict and the subject-scoped stall stay hard reds, that the deferral names
  its reader, and that an absent subject has a name and is said out loud.
- `tests/unit/platformFreezeWindow.test.ts` - the measurement itself, the
  budget derived from the row, the database ceiling, thaw / exhausted /
  unreadable, and a pin that neither cleanup path carries a blind tick budget
  any more.
- `tests/unit/productionE2EAccount.test.ts` and
  `tests/unit/temporaryCustomizationAccountCleanup.test.ts` now prove the
  freeze's end condition is what releases the cleanup, and that a freeze which
  outlives its budget is refused with the measurement in the message.
- `tests/unit/customizationCommerceCertification.test.ts` moved its pin off
  `PLATFORM_FREEZE_CLEANUP_ATTEMPTS` and onto the mechanism that replaced it,
  in this commit, as section 8 requires.
