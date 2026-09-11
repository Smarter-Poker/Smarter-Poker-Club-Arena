# Tournament-manager request fencing

> **Historical design record, superseded for execution.** This document keeps
> the original Stage-A/Stage-B rationale. The old isolated Stage-B artifacts
> were never applied and are archived as non-executable evidence. The only
> supported activation path is the ordered `stage_b_forward_authority_expansion`
> through `stage_b_lease_keyshare_once` chain; the composed manager-fencing
> postimage lives in `stage_b_current_postimage_contraction`.

## Failure being closed

A tournament lease generation previously fenced admission, heartbeat, launch
begin, and launch completion. It did not fence the manager's other PostgREST
transactions. A stalled process could therefore resume after a generation
takeover and commit an old blind update, seat move, bounty payment, table birth,
or settlement. Checking `running` after an `await` cannot undo the transaction
that already committed.

The fence belongs at the request transaction boundary. Every request made by a
verified tournament manager carries its immutable tournament id and lease
generation. The database validates that exact generation before the main query
and holds the lease row `FOR SHARE` through every mutating transaction. A
takeover updates the same row, so it cannot commit during an admitted old
transaction; after takeover, the old generation cannot enter another one.

## Runtime authority boundary

`dataActorContext.ts` owns one `AsyncLocalStorage` context:

- Outside manager work, both server Supabase clients overwrite caller values
  with `actor=service`, protocol 1, and no tournament authority headers.
- A verified manager overwrites them with `actor=tournament-manager`, protocol
  2, its tournament id, and its lease generation.
- The overwrite happens inside every physical fetch attempt, including retry.
- Lazy PostgREST thenables are materialized before the authority scope exits.
- A nested attempt to change tournament or generation fails closed.
- Every manager method is bound before the manager enters GameServer's map.
- Every verified tournament `ServerTableEngine` is bound immediately after
  construction. HTTP/WebSocket handlers receive that same bound object from
  `getTableEngine`, so callbacks that start outside the manager's original
  promise/timer chain cannot fall back to service authority.

There is only one runtime `createClient` construction boundary under
`server/src`: the bounded service-client factory used by the ordinary and
maintenance clients. Imported helpers and engine modules therefore inherit the
same fetch boundary; a new helper cannot silently create an unfenced client
without breaking the source guard.

## Database Stage A

`*_tournament_manager_requests_carry_lease_authority.sql` is the
database-first, rolling-deploy stage:

- Headerless requests remain admitted. This is mandatory while an old engine
  can still be serving.
- Marked server actors require a PostgREST-verified `service_role` JWT claim.
  The hook reads that identity through `auth.role()` and fails if it disagrees
  with the transaction's parsed `request.jwt.claims` role.
- Ordinary `service` requests remain unrelated to tournament authority.
- A marked manager requires an exact protocol-2 lease generation whose
  heartbeat is no more than 30 seconds old.
- `GET`/`HEAD` validate. Every possible write method validates and locks the
  lease row `FOR SHARE` in the same PostgREST transaction as the main query.
- The `SECURITY DEFINER` hook lives in `smarter_private`, a dedicated schema
  outside PostgREST's exposed schemas. API roles receive only schema `USAGE`
  and function `EXECUTE` so PostgREST can invoke it after role switching; there
  is no public wrapper and therefore no RPC endpoint. The function also refuses
  its own route if the private-schema deployment boundary is ever misconfigured.
- Installation aborts instead of overwriting an unknown existing
  `pgrst.db_pre_request` hook.

The 30-second database freshness window is the same audited boundary used by
the claim RPC. The engine's 20-second monotonic proof window remains stricter,
so a healthy local manager stops before another owner can take over.

## Complete manager mutation inventory

The authority wrapper covers direct writes, RPCs, imported helpers, detached
timers, promise continuations, and child dealer engines. The explicit current
manager surface is:

| Source                             | Direct mutation families                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TournamentManagerBase.ts`         | `tournaments`: break state, spin draw fields, level clock/current level, add-on window; `tournament_players`: unpaid removal, registered-to-playing/chips, table/seat linkage; `tables`: launch insert, blinds/stakes, button, player count; `table_seats`: launch insert, release/reactivate, stack funding |
| `TournamentManager.ts`             | `tournaments.final_table_triggered`; `tables`: close/count; `table_seats`: move, close, reopen, insert; `tournament_players`: playing/chips and table/seat linkage                                                                                                                                           |
| `TournamentManagerEliminations.ts` | `tournament_players`: corrected prize and winner result; `table_seats.left_at`; `tables.status`                                                                                                                                                                                                              |

Manager and imported recovery/settlement RPCs, including read-before-write
proof RPCs because PostgREST invokes them with `POST`, are:

1. `fn_apply_prize_guarantee`
2. `fn_begin_tournament_launch_atomic`
3. `fn_close_tournament_addon_period`
4. `fn_close_tournament_entry_window`
5. `fn_complete_tournament_entry_reprice`
6. `fn_complete_tournament_launch_atomic`
7. `fn_mystery_bounty_seed`
8. `fn_spin_draw_multiplier`
9. `fn_spin_settle_game`
10. `fn_sync_seat_first_player_count`
11. `process_tournament_rebuy`
12. `fn_ack_tournament_capacity_tables`
13. `fn_ensure_late_registration_capacity`
14. `fn_settle_satellite_finish_atomic`
15. `fn_bounty_obligation_has_complete_marker`
16. `fn_claim_tournament_bounty_elimination`
17. `fn_collect_bounty`
18. `fn_eliminate_tournament_player_atomic`
19. `fn_finalize_bounty_pool`
20. `fn_get_tournament_satellite_entitlement_depth`
21. `fn_mystery_bounty_pay`
22. `fn_mystery_bounty_reserve`
23. `fn_mystery_bounty_reveal`
24. `fn_mystery_bounty_settle`
25. `fn_normalize_tournament_final_standings`
26. `fn_open_tournament_rebuy_decisions`
27. `fn_settle_tournament_rake`
28. `fn_sweep_pending_tournament_bounties`
29. `fn_sync_tournament_live_seat_chips`
30. `fn_tournament_has_unsettled_bounties`
31. `fn_claim_tournament_finish`
32. `fn_certify_tournament_finish`
33. `fn_prepare_tournament_place_obligations`
34. `fn_settle_tournament_obligation`
35. `fn_settle_tournament_places_atomic`
36. `fn_settle_final_table_deal_atomic`
37. `fn_close_empty_tournament_table`

The bound tournament child dealer additionally invokes
`fn_decline_tournament_rebuy`; that route is manager-exclusive. Its exact hand
settlement and post-commit recovery routes are in the identified-engine family
because cash-table dealers legitimately use the same generation-aware doors.

Imported database writers reached from those methods include cancellation
refund/close, atomic place settlement, atomic final-table-deal settlement, and
tournament-finish claim helpers. All managed `ServerTableEngine` dealing,
seating, action, runout, and settlement calls are part of the same authority
surface. No manual call-site header list is needed or trusted.

Several relations and RPCs above are also legitimately used by scheduling,
registration, recovery, GameServer, and cash-table services. A blanket trigger
that treats every service-role write to `tournaments`, `tables`,
`table_seats`, or `tournament_players` as a manager write would break valid
traffic. The explicit actor marker is what distinguishes authority; relation
names cannot.

## Shared-estate service caller inventory

The pre-request hook is database-wide, but Club Arena is not the only product
using this Supabase project or its `service_role` credential. World Hub central
administration, production API, trivia, cron, catalog, and maintenance callers
also use PostgREST, including callers outside this repository that do not carry
Club Arena headers. Rejecting every unmarked `service_role` request would be a
shared-estate outage, not a tournament-manager fence.

Club Arena-owned callers were still classified and explicitly stamped as
defence in depth:

| Caller family                                                                                                       | Authority after this change                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hetzner engine work outside a manager authority scope                                                               | The one shared bounded client overwrites every physical fetch attempt with `service`, protocol 1.                                                                                |
| CI schema, DDL, telemetry, migration, copy, cron, relationship, and catalog gates                                   | `scripts/ci/supabase-auth-headers.mjs` emits immutable `service`, protocol 1 headers; request-specific headers cannot replace authentication or add tournament authority.        |
| Production certification and temporary-account cleanup                                                              | `production-e2e-account.mjs` and `temporaryCustomizationAccount.ts` use the same immutable service identity for Data API work; their publishable player clients remain unmarked. |
| Estate digest, publish watchdog, engine-version proof, ledger anchoring, migration backfill, and maintenance report | Their direct REST/curl requests now explicitly identify ordinary service traffic.                                                                                                |
| Tournament verification, chip hierarchy, horse aliases, seed/inspection utilities, and Sentry autofix               | Their service-role `createClient` instances carry global `service`, protocol 1 headers.                                                                                          |
| Tournament lobby browser audit                                                                                      | Only its privileged tournament-discovery REST read is marked service; the minted player/browser session remains unmarked.                                                        |
| Button asset uploader                                                                                               | Storage API only, not PostgREST/Data API; it is deliberately outside this hook.                                                                                                  |
| Browser/publishable clients                                                                                         | Unmarked by design and continue through the normal `anon`/`authenticated` path.                                                                                                  |
| World Hub and other shared-project service callers outside this repository                                          | May remain unmarked on ordinary Data API routes; the hook classifies them as `shared-estate-service` and does not reinterpret them as a tournament manager.                      |

The source guard recursively inventories operational JavaScript, TypeScript,
and shell utilities that combine a service-role credential with PostgREST or a
Supabase client. A newly introduced Data API utility fails the guard unless it
uses the centralized helper, the engine's authoritative fetch wrapper, or the
literal service/protocol pair. This prevents Club Arena utilities from drifting
back to ambiguous authority, but it is not a global activation prerequisite and
Stage B does not require unrelated estate callers to adopt Club Arena headers.

### Private route classification

Stage B applies authority at exact RPC paths before considering the generic
unmarked compatibility branch. It recognizes both PostgREST's `rpc/name` path
and the Supabase gateway's `rest/v1/rpc/name` shape, using exact array matches
rather than suffix or substring matching.

Manager-exclusive routes require `actor=tournament-manager`, protocol 2, the
exact tournament id, and the exact current lease generation. This family
contains launch, entry-window/reprice, capacity, rebuy, elimination, bounty,
satellite, rake, spin, and final-standing mutations that are invoked only from
a verified manager or its bound tournament child engine.

The smaller identified-engine family accepts either a verified manager or
`actor=service`, protocol 1 because it has legitimate non-manager recovery or
coordination callers. It contains exact table/tournament lease
claim/heartbeat/release, generation-aware hand settlement,
post-commit-obligation processing, `fn_ack_tournament_manager_wakes`, the
durable bounty-outbox sweep, and seat-first player-count synchronization. It
also contains the guarantee, finish-claim, place-obligation,
bounty-finalization, satellite, and rake RPCs used by the managerless
stuck-COMPLETING/cancellation recovery path. An unmarked old engine can enter
neither private family after cutover. The static guard inventories both manager
classes and their imported settlement/recovery helpers, and fails when a newly
referenced RPC is not in exactly one family.

Generic relation routes and unrelated RPCs remain available to unmarked
`service_role` traffic. The four manager row triggers apply only after the
request hook has established `actor=tournament-manager`; they do not guess
authority from a shared table name.

## Stage B activation contract

Stage B must be a separate forward migration, never a runtime switch, cron,
watch list, or reconciliation job. It may land only after deployment proof
shows the exact Stage-A engine build is served and no old engine process remains.
It must then:

1. Preserve unmarked `service_role`, `anon`, and `authenticated` requests on
   ordinary shared-estate routes.
2. Reject unmarked traffic on the exact manager/engine-private route families;
   reject a protocol-1 `service` actor on manager-exclusive routes.
3. Keep exact/fresh `tournament-manager` validation plus the transaction lease
   lock and scope its direct row writes to one tournament.
4. Drop legacy tournament and table lease claim/heartbeat/release functions,
   legacy three/two-argument launch functions, and both the public
   nine-argument generation-blind and eleven-argument obligations-blind
   hand-settlement wrappers. Only the obligations-aware twelve-argument
   generation-aware settlement door remains callable.
5. Revoke direct application-role access to both lease tables and preserve the
   method-binding, single-client, and utility-source guards.
6. Prove in a rollback transaction that shared unmarked service work succeeds,
   unmarked private-engine work fails, marked service cannot impersonate a
   manager, exact manager work succeeds, stale/replaced generations fail, and
   parent-table deletion cascades a live seat under the exact manager proof.

Stage A prevents every identified new-manager stale write. Stage B removes the
temporary compatibility doors used by old binaries at lease, launch, and hand
settlement boundaries and rejects their unmarked access to the remaining
private RPCs. Old processes must still be proven drained before activation:
with one credential shared by multiple products, the database cannot honestly
distinguish an unmarked direct manager relation update from legitimate unmarked
estate service work. Eliminating that final ambiguity requires a separate
engine JWT role/claim rolled out across the estate; it cannot be achieved by a
safe database-wide guess in this migration.

## Implemented Stage B migration

`*_stage_b_current_postimage_contraction.sql` is the composed forward-only
activation boundary. Its numeric prefix is assigned only after rebasing the
whole dependency chain above the current production ledger head; the stable
suffix is used by executable source laws. It is intentionally not part of the
database-first Stage-A rollout and must remain unapplied until deployment
evidence proves the exact Stage-A engine build is the sole running build.

The activation is one database transaction. It:

- uses a one-second lock timeout and a thirty-second statement timeout, so a
  busy live relation aborts the whole unchanged cutover instead of pausing
  table traffic behind DDL; any later operator attempt starts only after
  inspecting the catalog and re-establishing the audited quiet window;
- preserves unrelated unmarked `service_role` traffic as
  `shared-estate-service`, while unmarked `anon` and `authenticated` browser
  requests remain `browser`;
- requires an explicit actor only on exact manager-exclusive and
  engine-coordination RPC paths, including the optional `rest/v1/` gateway
  prefix;
- preserves marked protocol-1 `service` traffic and exact/fresh protocol-2
  `tournament-manager` traffic;
- records a transaction-local proof only after the pre-request hook holds the
  exact generation `FOR SHARE`, then scopes marked manager writes on
  `tournaments`, `tournament_players`, `tables`, and `table_seats` to the
  request's exact tournament without repeating the same lease query per row;
- installs the scope trigger as `a0_tournament_manager_write_scope`, before the
  existing `aa_` launch-proof triggers, preserving lease -> receipt ->
  tournament lock order;
- records each validated tournament-table parent DELETE in a transaction-local
  UUID array, so an `ON DELETE CASCADE` seat trigger can prove the exact parent
  after its tuple becomes invisible; nested deletes without that exact marker
  still fail closed;
- revokes direct application-role access to both lease tables, leaving only the
  exact SECURITY DEFINER claim/heartbeat/release interfaces; and
- drops every generation-blind tournament/table lease overload, both legacy
  launch overloads, and the nine- and eleven-argument hand-settlement wrappers
  without `CASCADE`, so an unknown dependency aborts the whole cutover instead
  of being removed. The only surviving settlement entry point is the
  twelve-argument generation-aware function whose final JSONB argument records
  durable post-commit obligations in the same transaction. Its exact
  `fn_ca_process_hand_post_commit_obligations(uuid)` recovery/consume RPC is
  also an identified engine-service route and remains service-role-only. The
  twelve-argument function delegates lease validation and atomic hand commit to
  the owner-only
  `fn_ca_commit_hand_settlement_exact_before_obligations(...)` core, not to the
  eleven-argument rolling wrapper that Stage B removes. Stage B re-revokes and
  verifies that core for every application role, then executes the surviving
  twelve-argument fixture after the drop so PL/pgSQL late binding cannot hide a
  broken dependency.

The row guard deliberately applies only when the transaction actor is
`tournament-manager`. Scheduling, registration, recovery, and cash-table
services legitimately overlap the same four relations, so a relation-wide
"service means manager" rule would reject valid work. PostgreSQL cannot infer
which JavaScript object initiated a request made with the same service-role
credential. That identity edge is pinned for the exact Stage-A engine by the
runtime contract: one shared client stamps every physical fetch attempt, every
manager method is bound before publication, and every tournament child dealer
is bound immediately after construction. Stage B then refuses a lost or
mislabeled service actor at manager-exclusive RPCs. A cryptographically distinct
engine purpose for generic relation writes would be a separate rolling
credential protocol and cannot honestly be smuggled into this activation.

Every manager HTTP mutation, including a `SECURITY DEFINER` RPC, enters through
PostgREST's configured pre-request hook in the same transaction. The hook sets
`app.smarter_manager_request_fenced=protocol-2` last, only after the exact fresh
generation has been validated and locked. The row trigger requires that marker,
actor, tournament id, and generation. It does not re-read the already locked
lease once for every affected row; a normal hand update therefore pays one
lease proof per HTTP transaction instead of roughly two proofs per seat. A
direct database service session is not a tournament-manager transport and has
no actor marker, so legitimate SQL administration remains outside this Data API
boundary.

The configured hook name is
`smarter_private.fn_smarter_data_api_pre_request`. Both migration stages abort
if `smarter_private` appears in an authenticator `pgrst.db_schemas` setting,
and they assert that no public function with the hook name exists. Production
activation must additionally verify the served Data API configuration/OpenAPI
surface because an environment-level `PGRST_DB_SCHEMAS` override is outside the
database catalog. `smarter_private` must remain absent from that served surface.

### Adversarial request matrix

| Verified JWT / actor                                              | Route                                      | Stage-B result                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `anon` or `authenticated` / unmarked                              | ordinary relation or RPC                   | Admitted as `browser`; existing RLS/RPC ACL remains authoritative.                         |
| `service_role` / unmarked                                         | ordinary shared-estate relation or RPC     | Admitted as `shared-estate-service`.                                                       |
| `service_role` / unmarked                                         | exact engine-private RPC                   | Rejected with `ENGINE_DATA_AUTHORITY_REQUIRED` or `TOURNAMENT_MANAGER_AUTHORITY_REQUIRED`. |
| `service_role` / protocol-1 `service`                             | identified recovery/coordination RPC       | Admitted; the RPC's own generation/transaction contract remains authoritative.             |
| `service_role` / protocol-1 `service`                             | manager-exclusive RPC                      | Rejected with `TOURNAMENT_MANAGER_AUTHORITY_REQUIRED`.                                     |
| `service_role` / protocol-2 manager, exact fresh generation       | own tournament                             | Admitted; mutating request holds the lease `FOR SHARE`.                                    |
| `service_role` / protocol-2 manager, stale or replaced generation | any manager route                          | Rejected with `TOURNAMENT_MANAGER_FENCED`.                                                 |
| fresh manager for tournament A                                    | core row belonging to tournament B or cash | Rejected by the `a0_` scope trigger.                                                       |

The rollback probe executes these cases in a transaction and rolls every data
change back. It also proves that all legacy tournament/table lease and launch
signatures plus every superseded hand-settlement signature are absent after
Stage B, while the newest exact settlement signature remains executable only
to `service_role` through its private route.

### Activation proof order

1. Apply Stage A and all generation/serialization prerequisites, including
   `*_post_commit_obligations_are_atomic_and_resumable.sql` as a
   database-first change. It adds the twelve-argument settlement function while
   temporarily retaining both older overloads for the rolling engine window.
   Do not yet apply `*_seat_first_inventory_is_created_atomically.sql`: the
   protocol-1 engine still calls that repair RPC, and the migration itself
   refuses while a fresh protocol-1 manager lease exists.
2. Deploy the Stage-A engine and its bound client/manager authority changes and
   prove its exact served SHA/artifact revision. Club Arena utility header
   changes should ship too, but unrelated estate clients do not block Stage B.
3. Prove `/health.tournamentLease.enforced === true`, every published manager
   has a lease generation, all old engine processes have drained, and the sole
   exact engine calls the twelve-argument obligations-aware settlement
   signature; do not infer any of these facts from elapsed time alone. Lease
   enforcement has no runtime off switch: neither cash nor tournament
   admissions may create a generation-less owner.
4. Run `scripts/dev/probe-tournament-manager-fencing-pg17.sh`. It creates an
   isolated PostgreSQL 17 cluster, requires the real obligations migration to
   sort between Stage A and Stage B, applies/reapplies the fencing
   prerequisites, and installs a catalog-compatible fixture for the
   obligations migration's exact twelve-argument and private-core signatures.
   It proves seat-first repair retirement refuses while protocol 1 remains,
   retires that RPC only after the old lease is gone, then applies/reapplies
   Stage B, executes the surviving twelve-argument fixture after the
   eleven-argument drop, runs the rollback authority and parent-delete cascade
   matrix, and executes the real two-session live-seat/roster race. The
   obligations migration's own full money-path rehearsal remains separately
   required; this focused fixture does not simulate rake, BBJ, promotion,
   insurance, or add-on settlement.
5. Apply `*_seat_first_inventory_is_created_atomically.sql`, verify both repair
   functions are absent, then apply Stage B once and reload both PostgREST
   configuration and schema.
6. Verify that a Data API request targeting the `smarter_private` schema is
   rejected as unexposed and that the public OpenAPI surface contains no
   `fn_smarter_data_api_pre_request` RPC.
7. Repeat the rollback probe and live engine/WebKit certification.

Emergency rollback is another audited migration: restore the Stage-A hook
first, then restore legacy overloads only if an old engine is being deliberately
reintroduced, and finally remove the row-scope triggers/helpers. Restoring old
overloads while the strict hook remains active is an invalid mixed protocol.
