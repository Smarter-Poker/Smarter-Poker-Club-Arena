# Scoped weekly accounting observer and browser period retirement

Source and native fixture authored only. **All SQL, application tests, protected execution, applied migration, provider sessions, deployment and live reconciliation are UNRUN.** This directory belongs to component35, after the complete unchanged component34 successor. It adds no payer, coordinator, scheduler, financial source or historical status rewrite.

## Exact source and bootstrap

- Component: `supabase/accounting/weekly-v3/components/20260914164900_browser_period_controls_retire_to_scoped_observation.sql`.
- Load `captured-preimages.sql` after the full captured baseline and correction supplement, before applying the whole candidate. It introduces only the four absent legacy period function definitions and the absent `ca_can_view_club` dependency, with their exact owner/ACL. It never invokes them.
- `captured-legacy.json` is the retained 2026-09-15 05:19:08.554609 UTC metadata capture. `captured-dependencies.json` is the retained 05:32:26.673473 UTC capture. Their original query/raw responses remain in the root task outputs. Both captures used explicit REPEATABLE READ READ ONLY, timeouts and ROLLBACK; no customer rows or financial function invocation.
- Run `regression.sql` only through the protected full-candidate native catalog after all35 components. It creates synthetic rows/temporary helpers and a non-owner LOGIN role in one transaction, flushes deferred constraints and rolls back.

The actual capture has a union-only run journal. Component142600 adds the standalone scope columns, generated key, constraints and policy;154500 adds scheduler visit time. Component35 guards that final source composition; it does not describe the live capture as if those changes were already applied. The source-derived final policy is compiled on a private temporary LIKE relation, compared as a complete PostgreSQL-deparsed expression, and dropped. The standalone unique-index definition is also source-derived. Native parser/deparser admission is still UNRUN.

Legacy guards bind full `pg_get_functiondef` MD5, owner, security, exact raw ACL and effective API-role access. The captured helper definitions and period columns/defaults, RLS/policies/constraints/triggers/ACL are retained. Period trigger functions bind full definitions and ACL. The final run relation's scope columns, keys, ACL, policy and absence of new external triggers are checked. The coordinator guard reverses the exact162500 timing changes, continuation changes, fairness changes and PNL predicate to the retained measured predecessor; it never calls or rewrites the coordinator. Private period/cascade body hashes, owner/config/ACL are checked without replacing those writers.

A changed `fn_set_settlement_period_status(uuid,text)` configuration must reject with P0001 `legacy_period_function_preimage_changed`, DETAIL `fn_set_settlement_period_status(uuid,text)`. The root full-bundle runner owns the late rejection/rollback cluster. Other guards have specific dependency/schema/authority failures, never a guessed compatibility fallback.

## Retired authority

These four retained signatures all raise SQLSTATE55000 `automatic_weekly_accounting_only`, including owner/service calls:

- `fn_open_settlement_period(uuid)`
- `fn_set_settlement_period_status(uuid,text)`
- `get_current_settlement_period()`
- `get_current_settlement_period(uuid)`

Return types and existing authenticated/service EXECUTE grants remain solely to provide a clear stale-client refusal. PUBLIC/anon gains no EXECUTE. Three name-based registry entries are closed; getter overloads share a name. No shim forwards to the coordinator or invents a successful zero result. Browser TRIGGER/REFERENCES rights, including column REFERENCES, are removed from settlement periods. Existing read policies and service maintenance authority remain unchanged.

The captured opener omits required `end_at` with no default. That is a source/catalog incompatibility, not evidence that it successfully created a period. The retired no-arg getter can otherwise create a global period, while the old UUID getter uses broad club-view authorization to expose union aggregate money. The new observer replaces neither behavior with a new money path.

## Exact v1 observer contract

`fn_accounting_run_observation_v1(p_expected_actor_id uuid, p_scope_kind text, p_scope_id uuid, p_period_start timestamptz, p_period_end timestamptz) RETURNS jsonb`.

Authenticated and service callers both require a non-null, nonzero actual `auth.uid()` equal to the expected actor. There is no engine/service/session-owner bypass. Union scope uses unchanged `ca_can_oversee_union`; club scope uses unchanged `fn_accounting_party_users('club', id)` and an actual non-union club. The general club-view helper is not used. The exact finite week must match `fn_union_week_start(start)` and `fn_union_week_start(start + interval '8 days')` across Pacific daylight saving changes.

Every successful return has exactly these15 fields:

| Field                    | Meaning                                                   |
| ------------------------ | --------------------------------------------------------- |
| contract_version         | Numeric1                                                  |
| actor_user_id            | Actual expected actor UUID                                |
| scope_kind, scope_id     | Exact union or standalone-club key                        |
| period_start, period_end | Exact canonical week, UTC ISO text                        |
| observed_at              | Statement observation timestamp, UTC ISO text             |
| expected_run_at          | Existing schedule-rule result only                        |
| record_found             | Whether the exact canonical journal key exists            |
| state                    | no_recorded_run, unavailable, running, incomplete, posted |
| recorded_scheduled_at    | Validated actual scheduled timestamp or explicit null     |
| attempts                 | Actual positive integer or explicit null                  |
| started_at, finished_at  | Validated actual timestamps or explicit null              |
| posted                   | Boolean true only for qualified posted state              |

No monetary values, raw result, failure reason, payee/club counts or IDs, error code, accounting_version, history or fabricated timestamps leave this reader. Function UTC/ISO configuration preserves actual stored microseconds. `statement_timeout=10s` and `lock_timeout=2s` are retained settings, not proof of a per-function elapsed-time bound or confirmed upstream cancellation.

An absent union run is `no_recorded_run`, found=false. An absent standalone club run is `unavailable`, found=false: current `clubs.union_id` cannot prove historical weekly applicability. A found malformed/legacy row is `unavailable`, found=true. All four recorded fields are explicit null in these states. Exceptions/timeouts are not absence. A valid failed row requires literal JSON success=false and is incomplete. Running records require finished_at=null; this records journal state and does not prove a currently executing process.

Every qualified found state requires exact scheduled_at equal to the existing rule, attempts>=1, finite ordered start/finish values no later than observed_at. Posted additionally requires status complete, an object result with literal success=true and numeric accounting_version3, exact actual union or standalone result identity, finite ISO result timestamps equal to the journal's exact week, and exactly one matching canonical period in settled/closed state. Period status alone never proves posted. Extra result money and diagnostics are discarded. Posted is a qualified recorded result, not fresh conservation, external delivery, scheduler or overall accounting certification.

Account failures use42501 `accounting_observation_account_changed`; authority failure uses42501 `accounting_observation_not_authorized`; invalid scope/week use22023 `invalid_accounting_observation_scope` or `invalid_accounting_observation_week`.

## Authored native cases and limits

The fixture directly calls all four retired signatures under authenticated/service/postgres, tests zero/one/multiple-union no-arg refusal, and snapshots30 authoritative tables including periods, runs, wallet/ledger rows, cashier/correction documents, invoices, Messenger delivery, notifications, push and alerts. It compares complete before/after rows for every retirement, observation and malformed-result case. It does not use row counts as a money-integrity substitute.

The main scope matrix changes both SESSION AUTHORIZATION to a new non-owner LOGIN and ROLE to authenticated. It covers union owner, unrelated union, club owner/co-owner/admin, ordinary member, actor mismatch, and the absence of club-to-union escalation. This is stronger than SET ROLE from a postgres session alone. It still originates in an isolated owner-controlled fixture and does not qualify a separate provider/JWT connection, all non-owner union-overseer variants, concurrent membership changes or browser account-switch transport.

Other cases include null/zero actors, zero/invalid scopes, service without actor, finite/misaligned weeks,167/169-hour Pacific DST weeks and Chicago run-rule times, stored microseconds across TimeZone/DateStyle changes,24 legacy/malformed/failed/running result/time variants, and missing/open exact periods. The full JSON whitelist excludes raw result/diagnostics. An existing private engine-authorized period writer still creates and replays an exact settled standalone period without changing the other29 captured authoritative tables; this does not invoke the coordinator or claim payment. Table/column REFERENCES, TRIGGER, MAINTAIN, write rights, private writer grants and all five RPC access contracts are asserted.

Duplicate-period corruption admission is guarded in the observer, but this fixture does not disable a unique index to manufacture that corruption. Dedicated simultaneous sessions, lock contention, role-change races, provider/RLS deployments, full coordinator financial execution and actual Monday scheduler/live reconciliation remain required. No runtime, release or universal correctness claim follows from source review.
