# The release path drops its last exception, and a stood-down release says so

2026-09-26, engine release path.

## 1. The 778075b4 custody exception is gone

#5266 let the restart certificate (`maintenance_certificate` in
`server/scripts/engine-release-transaction.sh`) admit the raw
`stopped_bank_custody_unconfirmed` reason when, and only when, the serving
release was exactly `778075b419d078c58565c284c0ca7c5225bb773a`. It was the only
way off that build and it worked: production went 778075b4 -> 1fc82ca8 ->
92d59cfb -> f1d956c3. But it broke the rule that no bank or custody reason may
enter the allow-list, and a rollback to 778075b4 would have re-armed it.

Removed: `STOPPED_BANK_UNBOUNDED_PREDECESSORS`, `RAW_STOPPED_BANK`, the
`releaseSha` read and the predecessor stderr line. The certificate no longer
reads who is serving at all.

- `tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts`
  section 2 now pins the raw reason refused from every serving identity,
  778075b4 included, and the exception gone from the source.
- NEW `tests/noServingReleaseBuysACustodyException.law.test.ts`: the
  certificate holds no 40-hex literal and never reads `releaseSha`; its
  allow-list is exactly the two F06 preparation reasons; every bank/custody
  reason derived from `MaintenanceBreak.ts` refuses from every serving identity
  even when the database proof says no hand is in the air. Negative proof: a
  copy of the certificate with the exception re-inserted is caught by both the
  static and the behavioural check.

## 2. "FORWARD TARGET BEHIND MAIN" did not kill the 02:44 cutover

The claim was that a merge during the break abandoned 399d59f8's release. The
run log (36212130903, 02:44:14Z) says otherwise: the line printed four times is
a warning (it has been since #4539) and the transaction went on to admit the
certificate - then died on line 1453 with `syntax error: operand expected`,
because the in-flight helper's announcement was captured as the
remaining-milliseconds figure. That is the fault #5273 fixed. A forward target
behind main already completes; nothing about merge timing needs to change for
a _client_ or _non-engine_ merge, and an engine merge during a window at worst
produces a newer release that the next window ships.

What WAS wrong is smaller. Two exact-SHA requests run side by side (the
concurrency group is per SHA). At 04:07 run 36216375852 sealed f1d956c3, and
run 36216296821 (target 31ee0764, the #5280 merge, which f1d956c3 contains)
then refused with "does not contain the sealed high-water release" - correct -
and was receipted "the durable Hetzner release transaction did not complete",
because the workflow's classifier only recognises
`is stale; protected main requires <sha>`, a phrase nothing had printed since
#4539. The refusal now carries both phrases when the sealed release is a
descendant of the target. Exit status (1), timing (before mutation) and every
gate are unchanged.

Pinned by `tests/aReleaseMainOutranIsNotABrokenRelease.law.test.ts`, which
drives the real `source_target_is_current()` against a fake history.
