# Non-satellite rulings use the canonical terminal authority

Preparation owned by Codex task `accounting_gap_review`, in the isolated
`codex-accounting-ruling-retirement` worktree. Production remains owned by the
parent PIPELINE STABILITY operator.

The existing `fn_settle_tournament_places_by_ruling(uuid,text,text)` first calls
the standings normalizer and then settles cached roster prizes. It requires
rake to have been paid beforehand, creates a legacy ruling batch, and changes
the event to COMPLETED without creating the current terminal receipt. The D10
rehearsal already established that this is not a usable non-satellite completion
authority. Revision 6 explicitly retires this use.

The bounded change refuses non-satellite events after locking and reading
their identity, before normalization or any payment, batch, or lifecycle write.
Satellite classification includes both variant/type markers and both target
columns. Existing satellite code, argument validation, defaults, ownership,
permissions and configuration are preserved. Historical ruling batches remain.
No active server, client, or deployment caller uses this RPC; only its schema
declaration and historical documentation were found outside migration history.

Non-satellite historical rulings retain the established D10 procedure: verify
and restore the exact paid contract where required, use
`fn_complete_tournament_terminal`, and write the evidence-backed audit record.
This change creates no replacement payout authority and makes no financial
adjustment. Ranking and Phase 3 compatibility belong to the parent integration.

The PostgreSQL 17 rehearsal reproduced a stronger failure than a blocked
completion: the old call returned `ok: false` after changing 166 standings and
repricing five players. The new call returns `non_satellite_ruling_retired`
before that normalization and leaves every public application table unchanged.
The COMPLETING fixture uses accepted hypothetical hands and real elimination
doors; its opening winner/status is explicitly synthetic and rolled back.
Operational calls run with normal triggers.

The native proof also passed six non-satellite classification refusals, eight
exact satellite predecessor comparisons across RUNNING and COMPLETING, six
source/owner/grant/configuration drift refusals, unchanged function metadata,
service-only access, migration reapplication, and unchanged application rows.
The satellite comparisons preserve the existing function's behavior, including
its normalization effects; they do not certify a new satellite payout path.

The ordinary E2 fixture was completed only after installation: 17 payouts,
304.00 total, all 167 ranks correct, preserved historical bust identities, and
no-change terminal replay. All seven D12 guards remained enabled. The copied
E2 subreceipt retains its original fixture's historical `mode` label; the
included `guardPoststate` records the actual seven enabled guards for this run.
The owned socket-only PostgreSQL cluster stopped after the rehearsal.

Reproduce with `python3 scripts/ci/rehearse-non-satellite-ruling-retirement.py`
after composing the prepared D12 source package. The runner also accepts
`--d12-archive` and `--d12-migration` paths to exact local copies of those two
artifacts. Both are SHA256-pinned; they are test-only dependencies. No D12,
D9, or Phase 3 function is changed by this retirement migration. The existing
20260909171500 ruling source supplies the local predecessor and is also pinned.

Exact final migration SHA256:
`5dc686d2937a7ba7718908e218af7b6a3c339d2e484d18514cb7be5900a5864e`.
The only changed RPC body moves from MD5
`b5e3efd9216d9570b1101577a8788ad8` to
`9cc595c1950af528220a77e295bddd19`. The native receipt includes runner/probe
hashes, drift outcomes, financial proof and exact replay hashes at
`evidence/2026-09-11-non-satellite-ruling-retirement/native-receipt.json`.

No TypeScript or runtime client/server source changed. Python syntax and the
new migration's allocation were checked. No production application, payout,
push, pull request, or engine qualification is claimed.
