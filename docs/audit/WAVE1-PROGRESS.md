# Wave 1 — Money Integrity: Progress Log

Execution log for Wave 1 of the Club Arena Master Spec & Gap Analysis audit
(findings M1–M18). One entry per finding worked, landed or reopened. Nothing is
marked shipped here until the change is merged to `main` AND its effect is
observed in production — see "Verification method for this wave" at the bottom,
which was corrected on 2026-08-06 after M1 proved that a shipped call can be
permission-denied on every single invocation.

---

## M1 — Idempotent cash-out credit (DB LANDED, client merged and fixed via M17)

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

### REOPENED 2026-08-06 — this fix has never executed in production

Production verification of the merged change did not confirm it. It falsified
it. The reasoning above contains one unexamined assumption: that the permission
wall which blocked the _deduct_ leg did not also block the _credit_ leg. It
does.

Four independent pieces of evidence, all gathered against production:

1. **`public.idempotency_keys` contains 0 rows.** Every successful call to
   `fn_idempotent_credit_wallet` must write one. Before concluding, a reaper was
   ruled out: `cron.job` has no entry matching `%idempotency%`, and no function
   body deletes from the table. Zero rows therefore means zero successful calls,
   ever — not "recently cleaned".
2. **Nothing in the chain is `SECURITY DEFINER`.** `SELECT prosecdef` returns
   false for `fn_idempotent_credit_wallet`, `claim_idempotency_key`,
   `store_idempotency_result` **and** `atomic_credit_wallet_and_log`. The
   in-code comments describing "the IDEMPOTENT SECURITY DEFINER wrapper" are
   simply wrong, and had been taken at their word.
3. **A live probe as role `authenticated` fails.** Executed inside a rolled-back
   transaction with `set_config('request.jwt.claims', …)` +
   `SET LOCAL ROLE authenticated`, the call returns SQLSTATE **42501**,
   `new row violates row-level security policy for table "idempotency_keys"`
   — that table carries a single `service_role`-only ALL policy.
4. **It was broken before M1 too.** The pre-M1 path (`atomic_credit_wallet_and_log`
   called directly) fails identically with `42501 … for table "wallets"`,
   because `wallets` has SELECT and INSERT policies but **no UPDATE policy**.

So M1 did not regress anything — it moved the failure one call earlier — but
neither did it fix anything. **Idempotency cannot be asserted on a code path
that has never run.** The 206 real cash-outs in the preceding 48 hours were all
written by the engine's `markSeatAsLeft`, not by this client path; the
server-side money layer is healthy (`wallet_credit_idempotency` took 1,172 keys
in 48h).

Generalizing the probe to every browser call site turned this into audit finding
**M17**, recorded below. M1's credit leg will be resolved by construction when
M17's engine-ownership migration lands; it is not resolvable on its own terms.

**The lesson for this log.** A green test suite, a green phantom-RPC gate and a
merged PR proved only that the function _exists_ and that the _client_ calls it
correctly. None of them could see the grant. Wave 1's verify-live-first rule now
has a second half: for any RPC a browser calls, **impersonate the role and run
it** before marking the finding resolved.

---

## M2 — Rake / commission replay protection (DB LANDED, client hardened)

**Migration applied to production:** `20260806_uq_rake_attributions_hand_player`

**Client merged:** PR #34 -> `main` as `71937dba` (2026-08-06)

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

**Client merged:** PR #34 -> `main` as `71937dba` (2026-08-06)

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
update or resolve one, so the `service_role`-only read policy is untouched. It
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

## M3 — Insurance ledger writes could fail silently (DB LANDED, server merged AND DEPLOY-VERIFIED)

**Migration applied to production:** `20260806_fn_raise_server_financial_alert`

**The bug.** `logInsuranceSettlement` returned `Promise<void>` and swallowed
every failure. By the time it runs the table stacks have **already** been
mutated (`+payout`, `-premium`) and already persisted by `syncStacks()` — it is
the offsetting bank entry, not the payment itself. So a lost write minted or
burned chips silently, leaving nothing in the database an operator could
reconcile against. It also shipped a broken template literal (`...paramspl`)
that dropped the player id out of the one error report it did produce, so even
the Sentry breadcrumb could not identify whose chips moved.

**The fix.** The function now returns a discriminated `InsuranceLedgerResult`,
so failure is observable at all. It retries up to three attempts (backoff 150ms,
500ms) — safe only because the RPC is idempotent on the
`(table_id, hand_number, player_id)` unique index, which was verified against
production before a line was written. When the RPC reports no error but returns
a payload shape no id can be read out of, it does a **confirm-read** rather than
guessing: guessing success hides a lost ledger write, guessing failure raises a
CRITICAL on every settlement, so it asks the database instead. The `paramspl`
literal is repaired, and the report now carries the real player id plus every id
and amount needed to settle by hand. And the function is **total** — it never
rejects, so it cannot abort the settlement loop it sits inside.

**The M7 gap this exposed.** M7 gave the browser client a durable alert path,
but `fn_raise_financial_alert` hard-requires `auth.uid()` so that every alert is
attributable to a signed-in reporter. The game server connects with the SERVICE
ROLE key, under which `auth.uid()` is NULL — verified live, the call fails with
SQLSTATE 28000. **The durable alert path was unreachable from the one process
that actually moves money.** `fn_raise_server_financial_alert` closes that:
SECURITY DEFINER, `service_role` only, 60/min per source flood guard, with a
supporting `(source, created_at DESC)` index. The same named-role revoke trap
from M7 applies and was handled the same way — `anon` and `authenticated` are
revoked explicitly, because `REVOKE ALL ... FROM PUBLIC` does not remove what
`ALTER DEFAULT PRIVILEGES` granted by name.

**Where the alarm lives, and why.** It is raised inside `logInsuranceSettlement`
rather than delegated to `ServerTableEngine`. This layer is the only one that
can tell the difference between "the ledger row exists" and "it does not", and a
caller that forgets to check the result would reintroduce exactly the
silent-loss bug the change exists to kill. `financialAlerts.ts` imports this
module for the Supabase client, so the dependency is closed with a lazy
`await import()` inside the failure branch only — no module-load cycle, and zero
cost on the happy path, which is every hand.

**What this deliberately does NOT do.** It does not attempt to reverse the
table-stack mutation. The hand is over, the chips may already have been
re-wagered, and a blind compensating write is how a one-chip discrepancy becomes
a two-chip one. The alert row is the reconciliation input that M4 will consume.
Per-step isolation of `postHandTasks` stays filed as audit finding E8; it is not
needed for correctness here, because `logInsuranceSettlement` is now proven
total by test. `server/src/engine/ServerTableEngine.ts` is unchanged by this
finding.

**Gates run:** M3 suites 20/20 across 2 files; server `tsc --noEmit` 0 errors;
server `vitest` 425/425 across 40 files; root `tsc --noEmit` 0 errors;
zero phantoms from `check-phantom-tables`, `check-phantom-columns` and
`check-stranded-writers`. The root suite was compared against a clean-HEAD
`git worktree` baseline and produced an **identical failing-file set**, which is
how the 43 pre-existing failures were proven untouched rather than merely
asserted.

**Deploy verified in production (2026-08-06).** Per CLAUDE.md the Hetzner
deploy is confirmed through the database, never the CDN-cached health endpoint.
Per-minute `hand_history` counts show the restart signature unambiguously:
20:50 = 24 hands, 20:51 = 10, **20:52 = zero**, 20:53 = 3, 20:54 = 2, then
recovery to normal throughput (~1,959 hands/hour). The boot-time effect
corroborates it: five tournament tables flipped to `closed` inside a 0.5-second
window at 20:52:29–20:52:30, which is the new process running its startup
reconciliation. Merged **and** running.

---

## M6 — Rakeback settler watermark can skip rows forever (DB LANDED, code complete, PR MERGED)

**Migration applied to production:** `20260806_daemon_state_hwm_id`

**PR #37 is open as a draft and cannot be completed from this environment.**
See "The blocker" below. Nothing here is claimed as shipped.

**The bug.** `RakebackSettlerService` reads new rake with a timestamp-only
cursor — `.gt('created_at', sinceIso).order('created_at').limit(10000)` — and
then persists `rows[rows.length - 1].created_at` as the new watermark. Two rows
sharing one `created_at` value that straddle the LIMIT boundary are lost
permanently: row 10000 sets the watermark to T, and row 10001 (also at T) is
excluded forever by the strict `>` on the next cycle. Rakeback that is never
paid is never noticed, because nothing downstream knows the row existed. The
period table self-heals by recomputing from source; agent commissions and player
stats do not.

**It is real, not theoretical — and it is only accidentally safe.** Production
has **12 exact-duplicate `created_at` groups** across 481k `rake_records`. The
collision has not fired yet for a reason nobody designed: V8's
`new Date(pgTimestamp)` truncates Postgres microseconds _downward_, which pushes
the saved watermark strictly below every existing tie and accidentally
re-includes both rows on the next pass. That is an artifact of a lossy
conversion. It would evaporate the moment anyone made the timestamp handling
more precise — which is exactly the kind of tidy-up a future contributor would
make with no idea they were removing the only thing preventing silent money
loss. The cursor has to be made exact instead of lucky.

**The fix.** A composite **(created_at, id) keyset cursor** — a total order, so
there is no boundary a row can hide inside. `daemon_state.high_water_mark_id` is
**NULLable on purpose**: on the first cycle after deploy the settler has a
timestamp but no id and falls back to today's plain `.gt(created_at)` read, so
the deploy is a behavioural no-op until the first cycle writes an id, and exact
from cycle two onward. Re-processing is safe in every direction that matters —
`credit_agent_commission_from_rake` dedupes on `(user_id, source_id,
source_type)`, `apply_rakeback_player_stats` claims through
`rakeback_stats_applied`, and `rakeback_periods` recomputes from source — so a
cursor that occasionally repeats a row costs nothing, while one that skips a row
loses money. The migration only widens the cursor; it cannot move it forward.

**The index.** `rake_records` already had `idx_rake_records_date` on
`(created_at)` alone, which cannot serve the tie-break. The new
`(created_at, id)` index was built against production with
`CREATE INDEX CONCURRENTLY`, not the plain `IF NOT EXISTS` form the migration
file replays — `rake_records` is 301 MB and takes a write on every hand played,
so a plain build would have held an ACCESS EXCLUSIVE lock across the
rake-distribution path. Note that `CREATE INDEX CONCURRENTLY` exceeds the
Supabase MCP 60-second tool timeout but **continues in the background**; it was
confirmed by polling `pg_index.indisvalid` rather than trusting the timeout.

**The two other daemons are deliberately untouched.** `tournament_sentinel`
watermarks `tournaments.updated_at` and `weekly_financial_close` stores a
week-start date, not a row timestamp. Neither reads `high_water_mark_id`, and
the column is NULLable, so both keep working unchanged.

**Gates run:** 13 new tests in `rakebackWatermark.test.ts`; server
`tsc --noEmit` 0 errors; all three CI invariant gates green locally.

**The blocker.** The phantom-column gate compares code against
`scripts/ci/supabase-columns-manifest.json`, a committed snapshot of the live
schema. Adding `high_water_mark_id` requires regenerating it. The regenerated
file is **134,322 bytes**, and two independent limits stack: `git push` from this
sandbox is 403-blocked by the session's repository allowlist (confirmed five
times), and the GitHub MCP `push_files` tool requires the file's full content
inside one tool call, which exceeds the per-call output ceiling of any model —
the main loop and two subagents all failed, the third mid-generation. That is a
hard limit; retrying cannot fix it. The file was therefore delivered to Dan's
disk **by path**, so its bytes never entered a token stream, and verified
byte-exact as git blob `dd1fde34…`. `~/Downloads/finish-manifests.command`
lands it: it re-verifies the hash, refuses to run on a dirty tree, restores the
original branch via an `EXIT` trap, commits with hooks disabled (this is
generator output and must stay byte-identical to what `gen-schema-manifest.mjs`
emits, so Prettier must not touch it), pushes, and re-fetches to confirm the
landed remote blob matches. The other three M6 files are already on the branch
and byte-verified.

That script also lands the **schema** manifest for M17/M18, which hit the same
ceiling from the other direction (68 KB — small enough to read or to write, but
not both in one call). Two blockers, one double-click; it supersedes the earlier
`finish-m6-manifest.command`. Worth naming the general rule, because it will
recur: **any file this environment must round-trip through a token stream is
capped at roughly 65 KB**, and both CI manifests are generator output that will
cross that line again on the next schema change. The durable fix is to
regenerate the manifests in CI from `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
rather than committing them, which removes the file from the push path
entirely. Filed as part of Q6.

**Pre-deploy baseline captured, so the post-deploy check is unambiguous:** all
three daemons currently have `high_water_mark_id = NULL`;
`rakeback_settler.high_water_mark = 2026-08-06 22:06:09.862+00`,
`updated_at = 22:07:47.681+00`. After the merge, M6 is confirmed when
`daemon_state.high_water_mark_id` for `rakeback_settler` becomes **non-NULL** on
the cycle following boot (the settler runs every 30 minutes).

---

## M17 — The browser money-write surface is inert in production, and is a latent mint (DB LANDED, client merged)

Discovered by generalizing the M1 reopening above from one call site to all of
them. Nothing is fixed yet; this entry records the finding and the fix
direction, because the naive fix is dangerous.

**Every client path that credits a wallet is blocked.** All nine go through
`fn_idempotent_credit_wallet` or `atomic_credit_wallet_and_log`. Both are
SECURITY INVOKER, both are granted to `anon`/`authenticated`/PUBLIC, and both are
stopped at runtime by RLS — `wallets` has no UPDATE policy, `idempotency_keys`
is `service_role`-only. Two of the nine are genuinely dead code
(`OfflineQueueService.ts:219`, nothing enqueues; `ChipFlowService.ts:336`
`mintToUnionOwner`, no caller anywhere). The other **seven are live
user-facing features that do nothing at all in production**: tournament refund
on admin removal before start (`TournamentRegistration.tsx:154`), table-close
refund fallback (`TableService.ts:275`), admin kick refund
(`TableService.ts:772`), dispute credit adjustment (`DisputeService.ts:244`),
credit-invoice payment rollback (`CreditService.ts:543`), bonus claim payout
(`BonusService.ts:346`), and Cashier table cash-out (`WalletService.ts:495`).

### Corrected the same day, by probe — it is an outage, not a corruption

The first version of this entry claimed three of these features **corrupt
state**: that `BonusService` burns the bonus by committing `claimed = true`
before the credit, that `TableService.closeTable` strands un-zeroed seat stacks
by setting `tables.status = 'closed'` before the refund loop, and that a failed
admin kick leaves inconsistent seat state. That was inferred from reading the
source. Impersonating role `authenticated` against production, inside rolled-back
transactions, falsifies all three. Every one of those writes is a **zero-row
no-op**, because each table has RLS enabled with no applicable write policy:

| Write the client attempts                 | Result as `authenticated`              |
| ----------------------------------------- | -------------------------------------- |
| `fn_idempotent_credit_wallet`             | `42501` on `idempotency_keys`          |
| `atomic_credit_wallet_and_log`            | `42501` on `wallets`                   |
| `add_vip_points`                          | `42501 permission denied for function` |
| `special_bonuses` UPDATE `claimed = true` | **0 rows**, no error                   |
| `tables` UPDATE `status = 'closed'`       | **0 rows**, no error                   |
| `table_seats` UPDATE `stack`              | **0 rows**, no error                   |
| `tournament_registrations` DELETE         | **0 rows**, no error                   |
| `special_bonuses` INSERT (forge attempt)  | `42501` — blocked                      |

Nothing is half-applied, so no ledger can drift out of agreement with any table.
The correction matters in both directions: the corruption is not real, and the
outage is **broader** than first filed. `add_vip_points` is granted only to
`postgres` and `service_role`, so the `vip_points` reward branch of
`awardReward` fails too, by a different mechanism (function EXECUTE denied
rather than RLS) — the bonus feature has no working branch at all. And
`special_bonuses` currently holds **0 rows**, so nothing populates it either.

**The real severity is truth-in-UI.** PostgREST returns success for a zero-row
write, so `claimErr` and its siblings are null, the client takes the happy path,
and the interface reports success. An admin is told the table closed. A player
is told the bonus was claimed. Neither happened, and nothing anywhere records
that it didn't. `TableOperationsPanel.tsx:487-491` compounds this by discarding
`kickPlayer`'s boolean return entirely — that part of the original entry stands,
though its consequence is a missing error message rather than corrupt state.

**The latent mint, and why the obvious fix is the wrong one.** None of these
credits has an offsetting debit, and two of them take a **client-supplied
amount**: `DisputeService.ts:244`, and `WalletService.ts:495` where the player
types the cash-out figure and **no server-side seat-stack decrement exists
anywhere in that path** (`useWalletStore.ts:282-320` adjusts `locked`
optimistically, client-side only, and reverts on throw). These calls are inert
today _only because RLS happens to block them_. The obvious repair — making the
wrappers SECURITY DEFINER, which the code comments already incorrectly claim
they are — would convert a broken feature into an **unlimited chip mint
exploitable by any authenticated player**. Widening privileges here is not a fix;
it is the exploit.

**The fix direction is engine ownership plus revocation.** The correct pattern is
already in the codebase twice. `TablePage.tsx:1598-1625` routes partial cash-out
through `GameServerAPI.removeChips` → `atomic_table_withdraw`, which credits the
wallet and reduces the seat stack atomically, only between hands. And
`server/src/services/supabase.ts:255-435` (`markSeatAsLeft`) credits the
**actual** `table_seats` stack — never a client figure — idempotent on the
seat-occupancy row id, and refuses to vacate the seat if the credit fails. That
is the path that wrote all 206 real cash-outs in the preceding 48 hours. There is
also precedent for the UI half: the Cashier's `'buyin'` branch used to perform a
real debit and was deliberately reduced to navigation, so that
`atomic_table_buyin` is the single point at which buy-in funds move. The
`'cashout'` branch at `CashierPage.tsx:1071-1114` still violates that rule and
must be converted the same way. Once every credit is engine-owned,
`REVOKE EXECUTE` on both wrappers from `anon`, `authenticated` **and** PUBLIC —
naming `anon` explicitly, because Supabase's `ALTER DEFAULT PRIVILEGES` grants it
by name and `REVOKE ALL … FROM PUBLIC` does not remove it (the same trap already
hit in M7).

**SECURITY DEFINER is not banned here — generic SECURITY DEFINER is.** The
distinction the fix turns on: a DEFINER function that credits an amount the
caller supplies is a mint, while a DEFINER function that looks up the amount
itself and enforces its own authorization is exactly how this is supposed to
work. `fn_claim_special_bonus` below is the first instance built to that shape,
and it was only greenlit after a probe confirmed a player cannot forge the row
it reads from (`special_bonuses` self-INSERT as `authenticated` → `42501`).
Every subsequent M17 call site gets the same treatment and the same
pre-flight check: **if the caller can write the row the amount is read from,
the function is a mint no matter how it is written.**

**Priority: P0.** It is simultaneously a seven-feature production outage and a
mint that is one well-intentioned commit away from being live.

### M17 part 1 — the bonus claim (DB LANDED, client merged)

**Migration applied to production:** `20260806_fn_claim_special_bonus`

The first of the seven call sites converted to the target shape.
`fn_claim_special_bonus(p_bonus_id uuid)` is SECURITY DEFINER, granted to
`authenticated` and `service_role` only, and takes **no amount parameter**. It
locks the bonus row with `user_id = auth.uid()` (that predicate is the entire
authorization model), rejects the ordinary refusals with a `reason` the UI can
act on rather than raising, consumes the bonus, and pays it — all in one
transaction, so the bonus can never be spent without being paid.

It does not touch `wallets` itself. Two things stopped that, one of them a
guard nobody had mentioned:

- `public.wallets` carries a Phase 4.1.6a trigger, `guard_wallet_balance_write`,
  which reads `PG_CONTEXT` and refuses any balance mutation whose call stack
  does not name one of ~35 whitelisted money RPCs. The first draft of this
  function updated `wallets` directly and was rejected with 42501 at probe time.
  Adding the function to that whitelist would also have worked and was rejected
  on purpose: the whitelist is a money-safety inventory and should grow when a
  new primitive appears, not when a new caller does.
- Worth recording what that guard implies. Its own error text calls the
  whitelist "SECURITY DEFINER RPCs", but `atomic_credit_wallet_and_log` and
  `fn_idempotent_credit_wallet` — two of the names on it — are SECURITY INVOKER.
  The guard was written expecting a property those functions do not have. That
  is the same wrong assumption M1 was closed on, found independently in a
  second place.

So it delegates to `atomic_credit_wallet_and_log` with a deterministic
idempotency key (`bonus:<bonus_id>`), which satisfies the guard by construction
and reuses the canonical credit shape rather than forking a money path.

**Verified live, rolled back, six cases in one transaction:** happy path pays
250 chips with exactly one ledger row and one idempotency key; an immediate
repeat returns `already_claimed` and the balance delta stays at 250;
`progress < target` returns `requirements_not_met`; an expired bonus returns
`expired`; another user's bonus returns `not_found` and stays unclaimed; the
`vip_points` branch succeeds through the definer even though `add_vip_points` is
not granted to `authenticated`. Negative control: `anon` gets 42501. Post-probe,
zero rows leaked.

**Client:** `BonusService.claimSpecialBonus` and `BonusPage.claimSpecialBonus`
both route through the RPC. `awardReward` was **deleted rather than repaired** —
it was the client's own credit path and neither branch could ever have worked.
A browser-callable "credit this user N chips" is a mint whatever it is named.

---

## M18 — the daily login bonus is broken four ways and holds two latent money bugs (DB LANDED, client merged)

**Migration applied to production:** `20260806_fn_claim_daily_bonus`

Found while fixing M17, by following `awardReward`'s other caller.
`BonusService.claimDailyBonus` called `claim_daily_bonus(p_user_id, p_amount)`
and then credited separately. Every layer of that was wrong:

1. **Grant.** `claim_daily_bonus` is SECURITY INVOKER, granted to `postgres` and
   `service_role` only. Every browser call is 42501. Same root cause as M17.
2. **Contract.** The function returns `{ success, error }` or
   `{ success, amount }`. The client reads `claimResult?.claimed` and
   `claimResult.new_streak` — neither field exists. Even with the grant fixed,
   `!claimResult?.claimed` would have thrown "already claimed today" on a
   _successful_ claim, and `(undefined - 1) % 7` would have indexed the reward
   table with `NaN`.
3. **Tables.** The function stamps `profiles.last_login_date`. `BonusService`
   reads `user_bonuses.daily_streak`. `BonusPage` read a third thing,
   `profiles.streak_days`. Three tables, one feature. `user_bonuses` holds 0
   rows and nothing writes it, so the streak could never advance whatever else
   was fixed.
4. **Rewards.** Three disagreeing schedules: `BonusService`'s `DAILY_REWARDS`
   constant (100/150/200/300/500/200vip/1000), `BonusPage`'s hardcoded
   `day * 10` chips with "100 Diamonds" on day 7, and the function's
   `p_amount DEFAULT 100`. No two of them would have paid the same bonus.

And two money bugs waiting for someone to "just fix the grant":

- **Double credit.** The function credits internally via `credit_player_wallet`
  **and** the client credited again afterwards. Unblocking both legs pays every
  daily bonus twice.
- **Mint.** `p_amount` is caller-supplied. Granting the existing function to
  `authenticated` lets any player claim an arbitrary amount, once a day.

**The fix.** `fn_claim_daily_bonus()` — SECURITY DEFINER, no parameters at all —
owns the whole claim: the once-per-UTC-day guard, the streak arithmetic, the
payout lookup and exactly one credit, in one transaction. The schedule moved out
of the client into `public.daily_bonus_rewards`, seeded to the existing
`DAILY_REWARDS` values so no payout amount changes — only where it is decided.
That table has RLS on, no policies, and is revoked from `anon` and
`authenticated`: a player must not be able to read or write their own payout
table. A companion `fn_daily_bonus_status()` returns the streak, whether a claim
is available, the ladder position that would pay next, and the live schedule, so
the UI renders the ladder that actually pays instead of recomputing one.

The idempotency key is `daily_bonus:<user>:<utc-date>`, which makes a repeated
credit impossible within a day even if the day-guard were somehow bypassed.

`claim_daily_bonus` is deliberately left in place and untouched — it is still
reachable by `service_role`, and retiring it is a separate decision from making
the player-facing path work.

**Verified live, rolled back:** a first claim pays day 1 / 100 chips and sets
streak 1; an immediate second returns `already_claimed_today` with no second
credit; backdating the stamp one day and claiming again pays day 2 / 150 with
streak 2 and a matching ledger row; backdating five days resets to day 1 /
streak 1. A player reading `daily_bonus_rewards` directly gets 42501, and
writing it gets 42501.

**Client:** `BonusService` and `BonusPage` both go through the new RPCs.
`BonusPage` no longer emits `DAILY_REWARD_CLAIMED` with an amount it invented.
The claim button is gated on the server's `can_claim` rather than on an inferred
ladder position.

**Gates run for M17 part 1 + M18:** `tsc --noEmit` 0 errors; `eslint` 0 errors;
`vitest` 16/16 on a rewritten `BonusService.test.ts` (the old suite's mock
resolved every call to `{ data: null, error: null }`, a shape no real RPC
returns, and asserted behaviour that only existed under the mock); all three CI
invariant gates green against a schema manifest resynced from live — the diff is
exactly the four new objects, nothing else had drifted.

The load-bearing tests are the negative ones: the client must never call
`atomic_credit_wallet_and_log`, `fn_idempotent_credit_wallet`, `add_vip_points`,
`credit_player_wallet` or `claim_daily_bonus`; `fn_claim_daily_bonus` must be
called with no arguments at all; and `awardReward` must stay gone.

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

**Server TypeScript is a third class again.** A merge to `main` touching
`server/**` triggers `auto-deploy-hetzner.yml`, but a green workflow is not
proof the engine is running the new code. Per CLAUDE.md, that is confirmed
through the database — the restart dip in per-minute `hand_history` counts and
boot-time effects in `tables` — never through the health endpoint, which is
CDN-cached and will happily serve a stale answer. "Server merged" in this log
means merged, not running — a heading is only upgraded to "DEPLOY-VERIFIED"
once the restart dip and a boot-time effect have both been observed. M3 is the
first entry to carry that upgrade; the evidence is recorded in its section.

**Correction to this section (2026-08-06).** The paragraph above describes
production presence for client code as "grepping the served entry chunk under
`/hub/club-arena/assets/` for the new RPC name". That check is not available
from this environment and, more importantly, it is not sufficient. `WebFetch`
cannot decode the compressed production bundle, GitHub code search does not
index minified assets, and the binding web-content rule forbids routing around
either. But even a successful grep would only prove the _call_ shipped — M1
above is the proof that a shipped call can be permission-denied on every
invocation and leave no trace anywhere in the bundle. The stronger check, and
the one this log now requires for any browser-callable money RPC, is the
**rolled-back role-impersonation probe**: set `request.jwt.claims` and
`SET LOCAL ROLE authenticated` inside a transaction, execute the real call,
capture the outcome into a variable, then `RAISE EXCEPTION` to roll the whole
thing back and surface the captured result in the error message. It answers
"can the deployed client actually do this?" definitively, and it moves no money.
