# A release killed by its own successor (2026-09-12)

Production ran `d68cc549` from 2026-09-11 23:57Z while `main` moved fifteen
times. Every one of those fifteen engine merges built a good image, and not one
of them cut over. The ledger said the same thing fifteen times:

```
release ended without complete production proof
```

It was not a production proof that failed. **The production proof never ran.**

## The mechanism, in one line

`source_target_is_current()` in `server/scripts/engine-release-transaction.sh`
required the release target to be the **tip** of `server/**` on protected main,
and re-required it after the image build and every sixty seconds of the wait for
the hourly break. A release takes 10 to 60 minutes because it waits for the :55
break. Engine merges were arriving every 13 to 22 minutes. So:

```
line 274:  [ "$latest" = "$SHA" ] || die "target $SHA is stale; protected main requires $latest"
```

Each release was killed by the commit that merged behind it, and that commit's
release was killed by the one behind IT. The chain is in the journal, verbatim:

| run           | target     | killed by, because it merged first |
| ------------- | ---------- | ---------------------------------- |
| 34660199908-1 | `eeeaa153` | `11c4e849`                         |
| 34661307499-1 | `11c4e849` | `0672aae7`                         |
| 34662607089-1 | `0672aae7` | `fba3bd0d`                         |
| 34665270660-1 | `8844f77e` | `78715c33`                         |
| ...           |            |                                    |
| 34673869399-1 | `240b3394` | `96c00643`                         |

Run `34673869399` is the whole thing in thirteen minutes: it started at
04:46:08Z, finished its image build at 04:59:28Z, fetched `main`, found
`96c00643` had landed while it compiled, and died. `96c00643` is the commit that
supervises the lease renewal loop - the fix for the live table churn that
started this investigation. **The commit that would have calmed production was
structurally the one commit that could not reach production.**

This is the failure class this workflow's own history already names. From
`docs/changelog/2026-08-28-a-green-deploy-that-deployed-nothing.md`:
"A condition a healthy production fleet can never satisfy is not a gate, it is a
deadlock." Here the condition is not about the fleet, it is about the repository:
a proof that can only succeed while nothing is merging is not a gate either.

## Why it looked like a health problem

`shipped` is `(sealed || already-released) && verified == 'true'`, and the ledger
reason was a three-way expression whose final branch caught everything else.
Four distinct outcomes rendered as one sentence about a production proof. The
GitHub API says plainly where every run actually died:

```
JOB Publish Through Hetzner Club Arena -> failure
   STEP 7 Dispatch the staged SHA through the durable Hetzner intake -> failure
JOB Record The Append-Only Engine Release Receipt -> success
```

Step 7 is the durable intake. The `verify` step never executed. Five hours of
investigation went toward an engine that was healthy the entire time.

## The fix

**1. Supersession may defer a release. It may not starve one.**
Standing down is still right while the newer commit can actually reach the break,
and outside the break window nothing changes at all: the same check, the same
`die`, the same message. Inside `SUPERSESSION_YIELD_SECONDS` (900) of the break,
or already inside one, a commit that merges now provably cannot build and arrive,
so standing down for it gives the break to nobody. Measured on run `34673869399`:
800 seconds from run creation to cutover-ready, plus 60 to 180 seconds for
`stage-engine-release` to detect the push and dispatch it.

The worst call site was the last one. `source_target_is_current` runs again
**after** the candidate is live and proven locally and publicly, immediately
before the seal commit. A merge landing in that 30 to 90 second window rolled
production back to the previous release: two restarts, two sets of parked hands,
for nothing.

**2. Forward-only ordering is now proved rather than inherited.** The tip check
was carrying that property incidentally - a target that is the newest engine
commit cannot be behind the sealed release. Now that the tip check is not
absolute, the escape asserts it in its own right against the seal's
`high-water-sha`, and **fails closed**: a superseded target that cannot prove it
contains the sealed high-water release does not ship. Production never moves
backwards. Protected-main containment, the maintenance certificate,
`prove_rollback_readiness`, `validate_candidate_image` and all three cutover
witnesses are untouched.

**3. Every override is counted.** The seal reason carries
`shipped inside the break window while superseded by <sha>`, which lands in
`engine-release-audit.jsonl` and `engine-release-seal.json`, and the transaction
emits `ENGINE_RELEASE_SUPERSEDED_BY=<sha>` into the run log. An override nobody
can count afterwards becomes the normal path without anyone deciding it should.

**4. A run that ships nothing says so.** The ledger now distinguishes a
stand-down from a transaction that did not complete from a cutover whose proof
failed, and names the successor. Every non-shipping run annotates
`::warning title=NOT DEPLOYED::` with the reason and writes it into the job
summary. The fourteen runs were red, not green - but a red row in a list of
1,500 runs is not a signal, and nothing said "production is still on last
night's engine".

**5. The chronic alarm got a rate detector.** `audit-engine-provenance.sh`
already asks "is production running main", hourly, as a boolean. It had been
answering "no" continuously since 2026-09-11 00:25Z; issue #4219 was open the
whole time. So production going from one release behind to fifteen releases and
four and a half hours behind **changed no state anywhere**. A chronic alarm that
never clears is the same blind spot as no alarm.
`.github/scripts/check-engine-deploy-starvation.mjs` reads the pipeline's own
append-only ledger and fires on the rate instead.

### The threshold, and the measurement it came from

Measured against the complete ledger, 2026-09-01 14:58Z to 2026-09-12 05:00Z,
94 episodes of consecutive non-shipping attempts:

|                                               |                                                             |
| --------------------------------------------- | ----------------------------------------------------------- |
| episodes with >= 3 attempts                   | 28                                                          |
| episodes spanning >= 120 minutes              | 15                                                          |
| **episodes meeting both (this rule fires)**   | **15**, about 1.4 per day                                   |
| episodes with >= 3 attempts under 120 minutes | 13, deliberately silent                                     |
| worst episode                                 | 30 attempts over 215.8 minutes; 739.4 minutes on 2026-09-02 |

Both conditions are required. Attempts alone pages on a normal merge burst -
five engine merges in twenty minutes is a Tuesday and four of them being
superseded is the queue working. Time alone pages on a quiet weekend. 120
minutes is two maintenance breaks, which is the worst-case latency this design
already states for itself in
`docs/changelog/2026-09-10-every-engine-merge-starts-its-own-train.md`.

It hangs off the existing hourly `production-integrity-audit.yml` on
`ubuntu-latest`: no new `schedule:` trigger (estate cron governance), never the
Claude scheduler (CLAUDE.md 10.85), and never the box it is watching. When the
ledger is unreadable it says **UNKNOWN** and exits 0 - "I could not tell" is a
third outcome and must never render as green.

## The accepted cost

Inside the last 900 seconds before a break, two candidates can now both be
alive, and the older one can win the cutover lock. It is a strict ancestor of
the newer one, fully tested, on protected main, and forward of production, so
shipping it is shipping something rather than nothing; the newer commit ships at
the next break. Against fifteen releases and four and a half hours of nothing,
that is the right trade.

## Also corrected

`.claude/skills/deploy-hetzner/SKILL.md` named `178.156.160.206` as the engine.
Verified by SSH on 2026-09-12: that host is `club-arena-turn`, the TURN server.
It runs no engine container and has no `/opt/club-arena`. The engine is
`5.161.252.33` (`club-arena-engine`). The skill also taught a raw
`git pull` + `docker build` + `docker run` + `docker image prune` sequence that
bypassed `engine-up.sh` - "THE single source of truth for how the Club Arena
engine container is run" - and therefore dropped `--label autoheal=true`,
`--label sp.role=engine`, `--label sp.release.sha`, the 50m/5-file log caps, the
health-check timings and the start lock. Rewritten at v3.0.0 around the actual
lane, the `:sha` / `:current` / `:previous` tag contract, and the real recovery.

Note for whoever reads this next: the version of that skill on `main` was
already fixed, and the version **on disk in both Mac clones** was not. Agents
load the file, not the branch.

## Pins

- `tests/the-deploy-can-always-ship.law.test.ts` - the stand-down still exists
  outside the break window with the same words; the yield window is shorter than
  one break period; the escape refuses without a proved forward-only ordering;
  every other release proof is unchanged; the override is recorded; the ledger
  distinguishes the four outcomes; NOT DEPLOYED annotates; the starvation alarm
  exists, is wired to a reader, fires on a count AND a span, and keeps its
  measurement beside its threshold.
- `tests/the-break-clocks-agree.law.test.ts` - the release transaction is now a
  surface that reads the :55 minute, and it must read the same one (CLAUDE.md 13
  rule 7).
- `tests/unit/engineDeployStarvation.test.ts` - the alarm's decision against the
  episodes that actually happened, including the two that correctly stay silent.

Each was proved to bite by reintroducing the defect it guards: restoring the
unconditional stand-down, removing the forward-only proof, and dropping the span
condition each turn the matching pin red.
