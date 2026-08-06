# Wave 1 — Money Integrity: Progress Log

Execution log for Wave 1 of the Club Arena Master Spec & Gap Analysis audit
(findings M1–M14). One entry per landed finding. Nothing is marked shipped
here until the change is merged to `main` AND observed in the production
bundle served from `https://smarter.poker/hub/club-arena/`.

---

## M1 — Idempotent cash-out credit (LANDED)

**Merged:** PR #33 -> `main` as `6b56ef4a` (2026-08-06)

**The bug.** `WalletService.unlockFromTable` is the client-initiated cash-out
money mover (reached from CashierPage). It called `atomic_credit_wallet_and_log`
inside a `retryAsync` closure. `retryAsync` retries on timeout and 5xx, and a
Postgres RPC can commit and then have its response lost — so a retry re-applied
the credit. Worst case for a duplicated _credit_ is minting chips that were
never locked at a table.

**The fix.** Route through the existing `fn_idempotent_credit_wallet` wrapper
(the DB idempotency framework — `claim_idempotency_key` +
`store_idempotency_result` — was already shipped). The key is generated ONCE,
**outside** the retry closure, so every retry of the same logical cash-out
shares a key and the DB de-duplicates, while a genuinely new cash-out gets a
fresh key. Key generation prefers `crypto.randomUUID()` with a timestamp+random
fallback. The wrapper returns `jsonb { ok, rpc }`, not a bare boolean, so the
result check tests `creditResult?.ok === false` rather than truthiness.

**What was deliberately NOT changed.** `lockForBuyIn` still calls
`atomic_deduct_wallet_and_log` directly. An earlier revision converted it to
`fn_idempotent_deduct_wallet` and all unit tests passed — but a live grant
check showed the inner `atomic_deduct_wallet_and_log` is granted only to
`postgres` and `service_role`, and `fn_idempotent_deduct_wallet` is not
`SECURITY DEFINER`. A client call would have failed permission-denied and
broken every buy-in in production. Buy-in deduction is engine-owned; the
right home for buy-in idempotency is the server path (`atomic_table_buyin`),
which is tracked separately. The reasoning is recorded in a comment at the
call site so nobody "fixes" it back.

**Also in this change.** Repaired a pre-existing broken mock in the
`internalTransfer` test, which resolved `{ error: null }` with no `data` and so
failed against the real `fn_wallet_type_transfer` contract.

**Gates run:** `tsc --noEmit` 0 errors; `vitest` 14/14 on WalletService;
`check-phantom-tables` 0 phantoms against a live 744-table / 1630-function
manifest (which is itself the proof that `fn_idempotent_credit_wallet` exists
in production); `check-phantom-columns` 0; `check-stranded-writers` 0.

---

## M2 — Rake / commission replay protection (DB LANDED, client hardened)

**Migration applied to production:** `20260806_uq_rake_attributions_hand_player`

**Filed as P0. It is not.** Verify-live-first downgraded it before a single line
was written. The canonical production rake writer is
`atomic_distribute_rake`, a SECURITY DEFINER function called by the engine —
every recent `rake_records` row carries `source='atomic_distribute_rake'`
(389,690 rows, most recent the same day as this audit). That function is
already fully idempotent on two levels: `ON CONFLICT (hand_id) WHERE hand_id
IS NOT NULL DO NOTHING` against the pre-existing `uq_rake_records_hand_id`,
plus a `rake_distribution_legs (leg_key, leg)` claim table guarding each
accumulator leg (`club_accumulator`, `union_rake`, `chip_treasury`)
independently, with a `v_recovered` flag so a partial failure resumes rather
than double-pays. The client commission path (`chip_ledger`
`category='commission'`) last fired 2026-03-24.

**The residual gap that WAS real.** `rake_attributions` had no uniqueness guard
at all. It has 0 rows ever, so nothing is currently wrong — but the table is
the intended destination for `CommissionService.attributeRake`, and wiring
that up later against an unguarded table would have created double rakeback
and double agent commission on any replayed hand-complete.

**The fix.** Close it in the durable layer first: a UNIQUE index on
`(hand_id, player_id)`, applied and verified in production. Then make both
client writers replay-safe against it — `RakeService.executePotDrops` and
`CommissionService.attributeRake` are now `ignoreDuplicates` upserts
(`onConflict: 'hand_id'` and `'hand_id,player_id'` respectively), so a replay
is a no-op instead of either a duplicate credit or a thrown 23505. The index
holds regardless of which client bundle is deployed; the upserts are belt to
its braces.

---

## M7 — Financial CRITICAL alerts were being written to /dev/null (DB LANDED)

**Migrations applied to production:** `20260806_fn_raise_financial_alert`
(plus a follow-up `REVOKE EXECUTE ... FROM anon`)

**Worse than filed.** The finding described an RLS denial affecting non-admin
users. The live database says otherwise: `financial_alerts` has RLS on with
exactly ONE policy, `financial_alerts_service_only`, scoped to `service_role`.
Every client session — admin or not — hit 42501, and
`FinancialAlertService._log` downgraded that to `console.warn` and returned
void. So 100% of client-initiated financial alerts vanished, and had been
vanishing for months: all 1,383 rows are `severity='critical'` and engine-written,
newest 2026-04-18. Every "ops will be alerted" recovery path in the client
was writing to nothing.

**The fix, in three parts.**

_Durable layer:_ `fn_raise_financial_alert`, a SECURITY DEFINER **raise-only**
entry point. Authenticated clients may raise an alert; they still cannot read,
update or resolve one, so the service_role-only read policy is untouched. It
refuses a NULL `auth.uid()`, clamps severity to the three valid values, and
truncates source/message. A per-reporter throttle (30/min, backed by a new
functional index on `(context ->> 'reported_by', created_at DESC)`) stops a
buggy loop or a hostile client from flooding the ops table — and it returns
NULL rather than raising, so the _first_ alerts of a burst always land.

_Grants:_ `authenticated` and `service_role` only. Note the trap — Supabase's
`ALTER DEFAULT PRIVILEGES` grants EXECUTE on new public functions to `anon`
**by name**, so `REVOKE ALL ... FROM public` does not remove it. `anon` had to
be revoked explicitly; grantees were then re-queried and are now exactly
`authenticated`, `postgres`, `service_role`.

_Client:_ `_log` routes through the RPC. Critically, it **no longer swallows**.
An unpersisted CRITICAL — RPC error, thrown call, or a NULL id from the
throttle — escalates via `reportError(..., 'FinancialAlertService.CRITICAL_ALERT_UNPERSISTED', ...)`
so it reaches Sentry. And CRITICALs now log at `console.error` rather than
`console.debug`, because `console.debug` is stripped from the production build:
a critical financial alert must never depend on a single channel.

**Verified behaviorally in production, not assumed.** Inside a transaction, as
role `authenticated` with a JWT claim, the RPC returned a real uuid; ROLLBACK;
0 leftover rows confirmed. Negative control: a direct client `INSERT` into
`financial_alerts` still creates 0 rows. RLS intact, RPC is the only path.

**Also in this change.** Repaired `tests/unit/CommissionService.test.ts`, which
had three failures predating this work: `mockRpc` had no default resolution so
`setRate` destructured `undefined` and died in the mock instead of the code
under test; the `executePayout` mock still returned the legacy
`commission_payouts` shape (`agent_id`/`net_payout`) instead of the live
`agent_commissions` shape (`user_id`/`amount`); and `vi.clearAllMocks()` does
not drain queued `mock*ValueOnce` implementations, so surplus one-shots leaked
across tests. `executePayout` also now reports its read-back failure instead of
silently emitting `COMMISSION_PAID` with the payout id in the `agentId` slot
and an amount of 0 — wrong data, not missing data.

**Gates run for M2 + M7:** `tsc --noEmit` 0 errors; `vitest` 60/60 across
FinancialAlertService (17), CommissionService, RakeService and WalletService;
schema manifest regenerated from the live DB (754 tables / 1651 functions, now
including `fn_raise_financial_alert`); `check-phantom-tables` 0,
`check-phantom-columns` 0, `check-stranded-writers` 0.

---

## Verification method for this wave

The CI invariant gates resolve every `.rpc()` call against a live manifest
pulled from the production database, so a passing `check-phantom-tables` is
positive evidence the target function exists — not just that the code compiles.
Production presence is then confirmed by grepping the served entry chunk under
`/hub/club-arena/assets/` for the new RPC name. Per CLAUDE.md §1.4, nothing is
described as deployed before that.

Four audit findings (S4, S5, S6, M13) were cleared as false alarms by the same
verify-live-first discipline, and it is what caught the
`fn_idempotent_deduct_wallet` permission trap above before it shipped. M2's
filed P0 severity is the fifth correction: the panic case was already solved
in the durable layer, and only a narrow residual gap needed closing.

Two classes of change land differently, and this log keeps them separate.
**Migrations are applied directly to the production database via the Supabase
MCP and are verified there** — behaviorally, inside rolled-back transactions,
with negative controls — so they are live independently of the frontend build
pipeline. **Client TypeScript is not deployed until the served bundle changes.**
Per CLAUDE.md §1.4, an M-number marked "DB LANDED" means the durable half is
protecting money right now; it does not mean the client half is in production.
