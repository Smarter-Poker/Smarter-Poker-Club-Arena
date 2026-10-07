# An older success never closes a newer failure (2026-10-07)

## What happened

`PostDeployVerificationIncomplete` episode 240356 was open. At 12:30:18Z run
37620236888, triggered by the publish of `b6a260b4`, failed its live-table
lane and bumped the episode. At 12:35:41Z run 37616370268, which had been
verifying the OLDER release `365b5f5f` since 11:46, finished green, and
`scripts/ci/record-post-deploy-verdict.mjs` wrote row 243237 resolving 240356.
Nothing had verified `b6a260b4`. A newer failure was erased by an older
success: a signal answering confidently when it could not tell (CLAUDE.md
10.86).

## The cause

`decide()` resolved whenever the newest episode row was `firing` and open. It
never asked what release the success covered, and it could not have: the
episode row keeps its FIRST occurrence's payload (`fn_record_operational_alert`
never rewrites evidence), so the release a later failure covered was recorded
nowhere.

## The fix

- Every failure now writes, in the same transaction as the episode bump, an
  occurrence receipt (`status = info`, `payload.kind = failed-release`,
  `payload.episode`, `payload.head_sha`). The episode is locked `FOR UPDATE`
  while a success decides, so a failure cannot land between the read and the
  write.
- A success closes the episode only when its release is the same as, or a
  descendant of, every release the episode failed on. The order comes from
  `git merge-base --is-ancestor` through
  `classifyRepositoryLineage` in `scripts/ci/production-e2e-provenance.mjs`,
  never from the clock.
- A success older than a failure is recorded as `kind = stale-success`
  (`resolves: null`, `newer_failed_releases`) and closes nothing.
- Unreadable lineage, a success with no release, or an episode whose
  deliveries outnumber its recorded releases (an episode opened before this
  receipt existed and bumped more than once) is recorded as
  `kind = could-not-tell` and closes nothing.
- The two verdict jobs check out full commit history (`fetch-depth: 0`,
  `filter: blob:none`), because a shallow clone would make every lineage
  COULD NOT TELL.
- The `previous` read ignores `info` rows, so a receipt can never be mistaken
  for the episode.

`scripts/ci/record-post-deploy-verdict.test.mjs` replays the 12:30/12:35
sequence with the real SHAs and pins stale, covering and could-not-tell
outcomes.

## The record of 240356

Row 243237 is evidence and is not edited. The correction goes through the
recorder's own write path, `fn_record_operational_alert`: the failed-release
receipt run 37620236888 would have written for `b6a260b4`, and the
`stale-success` receipt run 37616370268 now writes in place of a resolution,
naming 243237 as the receipt it supersedes. The failure itself is carried by
the open episode `e951244...` (row 243315), opened at 13:12Z on `68b28e5b`, a
descendant of `b6a260b4`; a success closes it only once it covers `68b28e5b`.

## Follow-up: every open episode, not only the newest

After the correction receipts above were written at 13:37Z, the recorder still
running on `main` (the pre-fix version) read the newest row without filtering
by status, saw an `info` receipt, found no open episode and minted
`57e641b3...` (row 243499) at 13:53Z beside the still-firing `e951244...`
(row 243315). The fixed recorder ignores `info` rows, but a success still only
looked at the newest episode, so e951244 would have stayed open for ever.

`settleOtherEpisodes()` now judges every other open episode of the same alert
(`firing`, not closed by the fleet, no `:resolved` row) on its own failed
releases, by the same lineage rule: resolve when covered, `stale-success` or
`could-not-tell` otherwise. A failing or non-verdict run settles nothing. The
three deliveries of 243499 (runs 37625799569, 37628489690, 37631535858) were
given their failed-release receipts through `fn_record_operational_alert`
(rows 243532-243534), so the next success that covers `88621375` can close it.
