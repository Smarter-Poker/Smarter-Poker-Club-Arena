# Phase 3 entry and cancellation evidence

This scoped supplement records evidence and remaining acceptance for the entry/cancellation lane. It does not declare Phase 3 complete or begin Phase 4. Production application and coordinated publication remain pending.

## Guarantee funding

Nine isolated PostgreSQL 17 groups passed using the installed guarantee wrapper, atomic core, bank debit, autojournal, escrow and immutability functions. The fixture checks all eight captured body hashes. A real 200-chip entry contributes 180 prize and 20 fee. A 120-chip overlay debits the selected club or union bank exactly once and brings prize escrow and the finalized pool to 300. The explicit overlay journal and its autojournal twin do not double-credit escrow.

The groups cover club, union, private-event, original-event-union and missing-union-wallet funding; replay; insufficient funds; rollback after a late journal failure; duplicate concurrent requests; and competing events sharing one bank. The fixture README and source manifest contain the exact scope. This proves the funding composition subset, not the real entry-window close or obligation maturity.

All nine groups printed PASS. The original runner then timed out during its existing 15-second private-cluster shutdown wait. A later `pg_ctl status` returned `3` (`no server running`), and only that stopped cluster was removed. The recovery record explicitly retains `runner_exit_success:false`. No production financial mutation occurred.

## Installed cancellation policy and callers

The written never-cancel policy is recorded in `tests/unit/tournamentsNeverCancel.test.ts` and `.agent/audits/2026-08-19-tournament-breaks-rake-and-never-cancel.md`. Started events resume or settle. The later unfilled, unstarted, pre-draw Spin expiry remains a scoped exception.

Installed catalog observation: 2026-09-10 03:15:50 UTC.

| Authority | Body MD5 | Installed role or caller finding |
| --- | --- | --- |
| `atomic_cancel_tournament(uuid,uuid)` | `6aae8b91e135ac1eac7e6a768b574c13` | Service execution; authenticated execution denied. Full function admits started evidence to its financial path. |
| `fn_close_managed_game(text,uuid)` | `d56413dc086039c43be531cc77267090` | Operator close refuses registered players and is empty-only. The application cancellation service delegates here. |
| `fn_spin_expire_unfilled(integer)` | `27da3d41bca0fe9e2df8f92d7b647aa7` | Existing parent-lock recheck limits expiry to unfilled, unstarted, pre-draw events. |
| `fn_spin_reap_stale_boards(integer,boolean,boolean,integer)` | `b2b503494a417caad57edf72214b250a` | Service-only; no installed function/cron or app/server caller found in the reviewed catalog and source. |

No active application caller of the legacy `refundAndCloseCancelledTournament` or installed caller of the old generic refund planner was found. Audit functions that mention authority names are not executable cancellation callers.

## Demonstrated violation and proposed refusal

The isolated baseline invoked the complete installed cancellation body with `started_at` set. It reached the first escrow write, raising the fixture's `PX001` trap instead of the expected policy refusal. This is an observed defect at the actual function boundary.

The candidate migration preserves existing terminal locks and stored-receipt replay, then refuses new cancellation with SQLSTATE `55000` when actual start, running/break status, positive Spin multiplier, completed launch, durable draw/reserve, persisted hand or paid non-refund obligation evidence exists. Scheduled `start_time` is deliberately not actual-start evidence. A positive multiplier is required because root confirmed the live default is `0` at 2026-09-10 04:16:55.977 UTC.

| Review item | Current value |
| --- | --- |
| Migration | `supabase/migrations/20260910035015_started_tournaments_resume_or_settle_instead_of_cancelling.sql` |
| Current installed body MD5 | `8c2641c634de919487c7bbb7eb8c5c22` |
| Current composed candidate body MD5 | `16ea7acbbf76613a0a1193dff18f1330` |
| Current migration SHA256 | `915fd9fd9f638e34df0d6b4c0f3fca184d8f16c87f53d8ab81d6873d61e6cb62` |
| Runtime verdict | Fourteen unchanged policy groups retained; current lock composition, migration application/replay and lock overlap passed |
| Production application | Not applied |

The earlier body `477a691d319638cb908f9ea62a10e12b` is superseded and unapplied: `IS NOT NULL` would refuse untouched default-zero Spin rows. Three refusal cases passed on that earlier candidate before a synthetic Spin setup violated its zero-fee constraint. Correcting that fixture and the multiplier guard does not transfer those results to the revised candidate. After the default-zero correction, eight revised refusal cases passed. The ninth case stopped during synthetic fixture setup because the valid obligation kind is `place`, not `prize`. Correcting that seeded value allowed the remaining six groups to pass with normal cluster cleanup. The candidate function and migration hashes were unchanged between those two segments. `scripts/dev/fixtures/tournament-cancellation-policy/runtime-evidence.json` preserves the first runner failure and the successful continuation separately.

The fourteen verified groups are nine refusals, three eligible routing cases, stored-response replay, and a parent-lock overlap with synthetic committed draw evidence. Eligible cases deliberately hit the first financial-write trap; they do not claim a funded cancellation. Synthetic receipt reading proves replay routing only. No actual draw RPC, hand commit, award payer, full cancellation settlement or historical restoration is exercised.

## Acceptance still open

| Control | Verified evidence and remaining acceptance |
| --- | --- |
| T01 | Existing seven pre-start registration groups reused. Actual late entry, finalization interaction and HTTP/RLS remain open. |
| T02 | Existing fee split evidence reused. Promotional funding remains partial. |
| T03 | Nine actual bank/ledger/escrow guarantee groups verified. Combine with actual entry-window closure and obligation maturity proof. |
| T04 / T05 | Existing thirteen purchase groups reused. Actual accepted-hand/settlement, funded bounty, and engine grant consumption remain open. |
| T06 | Existing unregister refund-provenance evidence reused. Full start/unregister/transfer overlap remains open. |
| S11 / AX10 | Installed never-cancel violation reproduced; revised refusal candidate passed fourteen groups; production application is pending. Draw overlap uses a synthetic marker rather than actual draw RPC. |
| AX07 / B12 | Written policy requires refusal after committed start/draw/awards. Revised refusal behavior is verified in isolated PostgreSQL; production enforcement awaits application. No speculative partial-refund policy or historical receipt rewrite is proposed. |
| BX13 | Actual bust, cutoff and finalization three-way overlap remains open. |

Mac command/file operations resumed after the earlier HTTP 504 failures. The revised recovery payload was synchronized into the same isolated worktree; no new dependencies or worktree were created. Fourteen policy results were recorded at 2026-09-10 04:30:54 UTC. No nine-group guarantee rerun or original cancellation baseline rerun was performed.

## Current authority composition

Preflight at 2026-09-10 04:35:57 UTC found exactly one source change: the inline terminal advisory lock became `PERFORM public.fn_ca_lock_settlement_lane_global();`. The installed helper (body MD5 `343015440ea5c84ee4ca7ae583c73d30`) takes the terminal lock and then the hand-settlement barrier. All cancellation financial statements, receipt routing and status checks remained byte-identical. The candidate preserves that current helper and adds only the previously verified refusal guard.

The installed helper was captured in the isolated fixture and its body hash verified. One focused composition group passed migration application and replay, resulting body verification, and the actual cancellation waiting behind committed draw evidence. The prior fourteen predicate results were reused because their guard and financial paths are unchanged. Evidence: `/tmp/ca-registration-funding-pg17-_885frnp/results.json`; the runner completed normally. The earlier `16f0` candidate was never applied and is superseded by this composed authority. Production application and publication remain pending.
