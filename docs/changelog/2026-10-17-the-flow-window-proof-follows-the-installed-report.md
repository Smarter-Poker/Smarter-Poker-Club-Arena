# The flow window proof follows the installed report (2026-10-17)

## What happened

The 2026-10-05 Midway union close paid round 1 to its clubs (2,180,462.68) at
2026-10-16 21:15. Since then it has paid nothing: rounds 2 (club to agents),
3 (agents to players) and 4 (invoices) wait on a certified P&L evidence
report. Read on 2026-10-17:

- In the 24 hours to 10:40 UTC, job 272 hit its 240 s statement timeout 104
  times. Timed-out visits are rolled back whole.
- Some time after 10:40, `fn_union_pnl_evidence_report` was replaced by the
  postimage of `20261017034258` (md5 `7b465b70...`). The original inventory
  generation moved from `...96ac03a8` to `...3e8afc28`, so every certificate
  of the close has to be proved again.
- `fn_accounting_union_earned_plan_advance` still pinned the previous report
  md5 (`edecfc...`). That pin admits the per-window flow proof, so the
  function returned at once and proved no window. The report was left to
  prove all 814,543 flows of the week in one statement (162 s and 2 GB of
  temp files when last measured), which no 240 s tick can hold after
  preparation.

## The fix

`20261017130300_the_flow_window_proof_follows_the_installed_report` moves
that one pin to the installed report. `20261017034258` changed only the
report's touched step, and `fn_union_pnl_original_flow_evidence` (`09745f78`,
also pinned) is unchanged, so the window proof is still derived from exactly
what it reads. The advance function is not one of the original inventory
matcher's sources, so the generation does not move again.

Law: `tests/the-flow-window-proof-follows-the-installed-report.law.test.ts`.
`20261017034258` itself now refuses while the old pin is in place (#7270), so
the same pair cannot drift apart again by applying that file.
