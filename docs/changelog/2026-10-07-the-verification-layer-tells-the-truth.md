# 2026-10-07 - The verification layer tells the truth

Five items, each verified against production and the Actions record before it
was touched. Times are UTC.

## 1. The Phase 1 certificate could never certify at this merge rate

**What was true.** `classifyReleaseWindow` asked one question of the whole
forty-minute client job: did `build-info.json` read the same SHA before the
first browser and after the last. `publish-club-arena` republished the client
on every merge (4 to 8 per hour at peak on 2026-10-07), so both client lanes
that passed on 2026-10-06/07 (runs 37587015087 and 37598789558) ended
`superseded`, `certified=true` was never written, and the seal job was skipped
on every one of 113 runs read. Five earlier client lanes (03:28 to 04:10, e.g. 37565880099) went red with "not a forward publish" on a forward publish; that
was the unrefreshed history fixed by #6351/#6364 before this work.

**What changed upstream, measured.** #6399 (merged 09:34) stops republishing
the client for merges that do not change the runtime. The first full client
lane after it, run 37604057526 (10:00 to 10:34), held one release
(`dfb8c753`), certified, and wrote the seal (client `dfb8c753`, engine
`5f768074`, `sealed_at` 10:34:50) - the first seal since 2026-10-05 22:06.

**What this change adds.** The seal never needed the whole job; it needs its
three Phase 1 journeys on one exact client. They now run first in the sweep,
bracketed by a `build-info.json` read immediately before and after
(`production-e2e-provenance.mjs bracket`). Certified only when BOTH reads are
the SHA the run recorded and took its specs from; a later release on either
side is `superseded` (exit 3), an unreadable read is `unknown` (exit 3), a
rollback or off-lineage SHA throws (exit 1). The publisher only moves forward,
so equal reads mean the journeys ran on that release. The seal requires
`phase1_certified` (journeys exact AND bracket held) instead of the whole-job
window, which is still computed and reported. At seal time a forward
protected-main client is accepted only if it still carries the Phase 1 marker;
the seal records the client that was tested, never the one serving.
fn_seal_phase_one_customization_cutover binds the engine to what is live,
unchanged. Never certifies a commit that was not tested.

## 2. A replaced queued lane was counted as a failure

**What was true.** `PostDeployVerificationIncomplete` (row 240356) was firing
from 2026-10-06 00:07 with 116 deliveries. Of the runs read: 41 of 41
cancelled client lanes and 12 of 12 cancelled live-table lanes had
`runner_id` 0 and zero steps (replaced while queued), and the seal was
`skipped` on all 113. Run 37604057526, which sealed, still fired: the SEO lane
skips by design on `repository_dispatch`.

**What changed.** `record-post-deploy-verdict.mjs` reads the run's own job
record (`actions: read`) and classifies a cancelled lane as `replaced` only
when it had no runner and no steps; an unreadable record is COULD NOT TELL and
stays loud (`could_not_tell_jobs`). A run whose only gap is a replaced lane
writes nothing and cannot close an episode. Lanes whose own `if:` was false are
`not owed` (`UNOWED_LANES`, built from SEO_OWED and SEAL_OWED, each pinned to
its job's condition); a failed or cancelled lane is never excused by it. A run
whose owed lanes all passed resolves the open episode.

## 3. Installed and merged migrations agree

- Recovered byte-exact from `schema_migrations.statements` (base64 across the
  tool boundary, decoded by the shell, no newline added), md5 and length equal
  to `fn_ca_migration_text`: 20261006024118 (7687 B, 932541af), 20261007001435
  (5371 B, 1b784ad2), 20261007002846 (1697 B, 376087a0). None existed on any of
  812 Club Arena or any World Hub branch. Manifest rows added.
- Left alone: 20261006053300, 20261006061400, 20261006061500, 20261006143500
  are on World Hub open PR #2183 (`agent/codex/trivia-p9-12-certification-20261006`).
  The check stays red for the three older than 24 h until that PR lands.
- 20261005230230 is not superseded and not wrong: it is the finalizer gated on
  a seal for the heartbeating engine and on the bounded normalization of
  20261005230204, whose pages had never been sent (307,146 invalid flags,
  `final_table_cleanup_progress.complete=false`). With the 10:34 seal live,
  the pages were sent through Apply Merged Migration (see the PR for run ids)
  and the finalizer is applied the same way once `complete=true`.

## 4. The flaky required check

`P10 audit F8 ... still fails closed for an applied receipt` built its PLO4
fixture without `phase10EvidenceMode`, so the policy read the real clock
against its 4 ms live budget and fell back to `work_budget` on a slow runner.
Reproduced with a clock that advances 7 ms per read (1 failure; P11.1 and
P12.1 already use evidence mode and passed). The fixture now uses the injected
zero clock, and a new test pins that the applied fixture survives that slow
clock. No budget raised, nothing skipped.

## 5. Remaining Post-Deploy E2E reds

- `production-daily-missions.spec.ts` `page.reload: net::ERR_ABORTED`
  recurred after #6391 (run 37590609407, 08:05, step "different-card rerolls
  serialize across concurrent tabs"). #6397 (09:02) replaced that reload with
  a fresh-panel remount; the suite passed on both later full runs.
- `production-customization-realtime.spec.ts`: the `page.goto` timeout did not
  recur after #6391; a different failure did (run 37595045099, mobile preset
  predicate). #6400 (09:46, another agent) adds the evidence to diagnose it;
  left to that owner.
