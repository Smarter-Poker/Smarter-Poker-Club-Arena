# Cash source refusal, retry and compatibility audit

This is source and disposable PostgreSQL evidence. These candidates were not applied by the settlement-integrity helper. No production money, balances, historical agreements, rates, commits or pushes were changed by this work.

## Failure and resulting behavior

The worker used one global rake cursor but treated a missing source allocation, commission exception or player-stat failure as a reason to stop that whole cursor. A source could already have committed some independent operations while the worker kept replaying the same page. Skipping a failed source would have lost the later player-stat and weekly-calculation obligations.

Migration `20260914144442_cash_accounting_refusals_are_durable_and_retryable.sql` introduces one durable work authority around the existing whole-hand liability writer, not another commission calculation or payout path. Each acknowledged source has its original per-player statistics applied through `apply_rakeback_player_stats`, plus pending requests in the existing `accounting_period_recompute_requests`. All of these operations share the source subtransaction. A failure rolls them back before an immutable refusal receipt and retry work are recorded. An acknowledgement/work-link failure rolls back the entire call and cannot yield a handled receipt.

`accounting_cash_source_receipts` is append-only. `accounting_cash_source_work` names the latest receipt and next bounded retry time. Both explicitly revoke default service writes and grant service SELECT only. The existing `fn_credit_agent_commissions_batch` accepts one `cash_rake_record` item per raw source and returns receipt version 3. `ok` counts accrued sources; `failed` includes refused sources and `blocked` counts only durable refusals. An unrecorded failure cannot be misrepresented as quarantine. Old per-player batch items remain supported.

The worker invokes bounded retries before fetching new rows, submits every positive cash source even if contribution or hand fields are absent, and reads back every blocked receipt and its retry work before moving the global watermark. Missing/mismatched readback, malformed or missing acknowledgements, unhandled errors and transport failures retain the cursor. Accepted source credits select the original period calculator; the worker no longer independently calculates cash shares or invokes a second player-stat batch. Tournament source handling remains with its terminal recognition authority.

## Weekly boundary

The private checker `fn_cash_source_refusals_for_period(union_id, club_id, from, to)` returns `status`, `count`, and stable sorted source IDs/reasons. A proved union bank receipt assigns that refusal to its actual union even when player attribution is absent. Private cash uses the actual bank club and observed union membership. After the observer/source cutover, an absent membership is a standalone club; unprovable historical private scope blocks that week conservatively. A refusal in another week is excluded. Invalid nonfinite source times conservatively block every potentially affected week.

The root integration owner is adding a separate forward preparation guard that calls this checker under the existing scope/week lock before club and payer discovery. This helper did not edit root A or J to add that integration. The existing raw-source quality checks also reject unaccrued/legacy sources. Cursor advancement is not a certificate of weekly completion.

## Compatibility entry points

Migration `20260914145706_cash_compatibility_calls_share_durable_source_authority.sql` revokes service access to the inner `fn_accrue_cash_hand_commissions` function. Required service compatibility functions `credit_agent_commission_from_rake` and `calculate_cascading_commission` delegate cash sources to the same durable authority. They preserve the original engine/JWT guard despite using SECURITY DEFINER to call the private authority. Successful calls require the explicit accrued receipt. Source/table/hand/club/contributor identities cannot conflict; caller-supplied amounts never replace original source amounts.

The old void function cannot return a refusal status. The old `settle_hand_atomically` caller also marked any returned JSON as success. Both compatibility functions therefore raise on refused sources. As with every PostgreSQL exception, that compatibility transaction rolls back its attempted refusal receipt too. The daemon's batch/retry interface establishes durable quarantine; compatibility callers receive truthful failure and cannot mark a refused financial operation successful.

Read-only installed-function and source inventory found:

- No repository TS/edge caller for the direct inner cash accrual function or direct legacy commission function.
- No repository TS/edge caller for `settle_hand_atomically` or `record_rake`.
- Installed `settle_hand_atomically` calls `record_rake` before cascading commission. The union branch delegates the canonical producer first. Its old private branch lacks canonical bank/attribution receipts and already fails the A source proof; this work leaves both old bodies unchanged.
- Installed `fn_attribute_tournament_rake` invokes the existing noncash commission branch. That branch is preserved byte-for-byte in this forward compatibility migration; the tournament candidate owns its replacement caller.
- `CommissionService.calculateCascadingCommission` had zero callers, sent the nonexistent `p_player_id` parameter and supplied no durable source identity. Only that dead browser method was removed; other service/dashboard work was preserved.

## Verification

`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.bare GIT_CONFIG_VALUE_0=false bash scripts/dev/test-cash-source-refusals.sh` passes **32 PostgreSQL assertions**. It loads actual A whole-hand accrual and the read-only captured installed player-stat function. Checks include multi-contributor posting, rollback on commission/stat/period queue failure, final acknowledgement/work-link failure, exact original hand/stat totals, immutable receipt and grant boundaries, no-agent standalone sources, scoped and unknown-week refusal, durable repair retry, duplicate and concurrent calls.

`... bash scripts/dev/test-cash-source-compatibility.sh` passes **55 PostgreSQL assertions** total. This includes the Q checks above, compatibility permission and failure tests, actual canonical bank/attribution producer cases, and actual producer followed by compatibility accrual in the same transaction for both an ordinary no-agent private player and a union hierarchy. Competing source callers produce one liability receipt, one original stats application and one acknowledgement. These tests use no substituted source/stat/producer/compatibility function bodies. The narrow fixtures construct required table surfaces and historical data; they do not certify all live schema/trigger behavior or historical money.

The accounting server suite passes **194 tests across 9 files**, including 57 worker cursor/receipt cases and 33 strict source receipt contract cases. Original allocation, attribution, tournament nonduplication, weekly completion parser and shutdown ownership cases also pass. A complete server TypeScript program using the already installed canonical dependencies resolved read-only reports **zero diagnostics**. No dependency install, copied dependency directory or symlink was used. The focused CommissionService/dashboard/agent-book suite also passes **101 tests across 4 files** after removing the unused browser method. Local whitespace/diff checks pass.

## Frozen migration identities

Q file SHA256: `b4796c032b394ca2f3f4dfc759ea1e7991167a39b70aec007e20afbb1f3f2fb6`.

- Q source authority MD5: `4269a18e6fd4e0b9616663f18b40e516`.
- Q existing batch MD5: `3b9313fc37e62ca2c0b0bbbc7fdc6dc0`.
- Q retry MD5: `46fd2049b408c1730aaabb0cc1d4b1f1`.
- Q refusal checker MD5: `ac7d777693e79eca6a13084b51cd1305`.
- Prerequisite A preparation MD5: `eb7124bc10101dafa7f85c52c7bfd796`.

Compatibility file SHA256: `a9fac16453f2209501374267c30d97880b18368ffd3e94530519c1fd0331a834`.

- Legacy cascading wrapper MD5: `67cb2c1eff42c6555d2c78be453481fb`.
- Legacy void wrapper MD5: `c079a824e20286136aeb5edfae587ac3`.

The source commercial formula remains unchanged and unresolved user terms are not inferred. Legacy unverified history remains unpaid and cannot certify a week. Production installation, root preparation integration, deployment and live behavior require separate evidence.
