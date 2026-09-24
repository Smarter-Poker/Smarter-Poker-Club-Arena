# Capability Registry And Accepted-Event Continuation: Interface Contract

Owner: Prompt 1 (technical platform). Consumer: Prompt 2 (diamond commerce).
Source of truth: `supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql`.
Qualified by: `scripts/ci/test-capability-registry.py` (CI step "Capability registry and accepted-event continuation"
in the `accounting_postgres` job) and `tests/unit/capabilityRegistrySeedsFixture.test.ts` (the seed copy
`scripts/ci/fixtures/capability-registry/seeds.json` equals the migration). The client side is held by
`tests/one-capability-registry.law.test.ts`, which ships with the first consumer (see section 1).

Commerce maps its commercial catalog onto the capability ids below. It does not redefine game rules, readiness or
the ids, and Prompt 1 does not change this contract silently: a change to anything in this file ships with a change
to this file.

## 1. Capability ids

| capability_id                        | rule_version         | scope      | variants                                             | readiness at install |
| ------------------------------------ | -------------------- | ---------- | ---------------------------------------------------- | -------------------- |
| `club.membership_cap`                | `club-membership-v2` | club       | none                                                 | implemented          |
| `tournament.discovery.trait_filters` | `trait-filters-v1`   | tournament | none                                                 | tested               |
| `cash.fixed_limit.kill_pots`         | `kill-v1`            | cash_table | `flh`, `flo8`                                        | planned              |
| `tournament.multi_day.single_flight` | `multi-day-v1`       | tournament | none                                                 | planned              |
| `tournament.multi_day.multi_flight`  | `multi-flight-v1`    | tournament | none (requires `tournament.multi_day.single_flight`) | planned              |
| `cash.insurance_ev_cashout`          | `insurance-v1`       | cash_table | none (see note)                                      | deployed             |
| `variant.ofc`                        | `retired`            | platform   | none                                                 | excluded             |

- Ids are stable, dotted, lower_snake segments. An id is never reused for a different rule; a rule change is a new
  `rule_version` on the same id.
- `cash.insurance_ev_cashout` is a cash feature (the engine refuses insurance on any tournament table). Its variant
  list is empty because the engine has no variant allow-list for it; its gates are table type and hand shape.
- `variant.ofc` is the owner's decision: there is no OFC. It is never available and must never be sold, listed as
  "coming soon", or bundled.
- The readiness column above is a snapshot. Always read the live value.

The client mirror ships with its first consumer, not with this registry: `src/config/platformCapabilities.ts`
(`PLATFORM_CAPABILITY_IDS`, `PlatformCapabilityId`, `CAPABILITY_READINESS_ORDER`, `isAvailable`,
`readPlatformCapabilities`), the hook `src/hooks/usePlatformCapability.ts`
(`usePlatformCapability(id | null): 'loading' | 'available' | 'unavailable' | 'unknown'`, one shared read with a
60 s TTL, failed reads never kept) and `tests/one-capability-registry.law.test.ts` land together, byte-identical in
every consumer, so nothing under `src/` exists that the app does not import. Until this migration is in the same
tree, that law compares the mirror to `scripts/ci/fixtures/capability-registry/seeds.json`. A surface shows a gated
control only on `'available'`; a feature keeps its own capability id constant in its own module.

## 2. Readiness

One ladder, lowest first:

| readiness             | meaning                                                                                                       | available |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| `excluded`            | Owner decision that the capability does not exist on this platform. Not a rung the writer can enter or leave. | no        |
| `planned`             | Agreed, not built.                                                                                            | no        |
| `implemented`         | Code exists on a branch or main; not qualified.                                                               | no        |
| `tested`              | Qualified by its tests/harness; not installed in production.                                                  | no        |
| `deployed`            | Installed in production (migration applied, engine/client release live). Requires evidence.                   | **yes**   |
| `production_verified` | Observed working on live production traffic. Requires evidence.                                               | **yes**   |

"Available" means `deployed` or `production_verified`, and nothing else. Commerce MUST NOT sell, enable or advertise
a capability that is not available, and MUST NOT treat any readiness below `deployed` as "almost available".

## 3. Functions

### `public.fn_capability_available(p_capability_id text) RETURNS boolean`

STABLE, SECURITY DEFINER. True when the capability's readiness is `deployed` or `production_verified`. An unknown id
is `false`. This is what server-side validation calls. Executable by `service_role` and `authenticated` (not `anon`).

### `public.fn_platform_capabilities() RETURNS jsonb`

STABLE, SECURITY DEFINER. The public projection, a JSON array ordered by id:

```json
[
  {
    "id": "cash.insurance_ev_cashout",
    "version": "insurance-v1",
    "title": "Insurance And EV Cashout",
    "scope": "cash_table",
    "variants": [],
    "compatibility": {},
    "readiness": "deployed",
    "available": true
  }
]
```

No evidence field. Executable by `anon`, `authenticated` and `service_role` (capabilities are not secret). A client
reads it through `readPlatformCapabilities()`, which returns `{status:'unknown'}` rather than an empty list when the
read fails, and offers a capability only when `available` is true AND the readiness is an available rung.

### `public.fn_event_continuation(p_event_kind text, p_event_id uuid) RETURNS jsonb`

STABLE, SECURITY DEFINER. Executable by `service_role` only (see section 5).

```json
{
  "accepted": true,
  "continuation_active": true,
  "continuation_via": "<event id whose open acceptance grants it>",
  "accepted_at": "...",
  "club_id": "...",
  "union_id": "...",
  "parent_event_id": null,
  "concluded_at": null,
  "conclusion": null,
  "capability_versions": { "cash.insurance_ev_cashout": "insurance-v1" }
}
```

- `accepted`: an acceptance record exists for this event.
- `continuation_active`: this event is accepted and not concluded, OR any ancestor through `parent_event_id` is
  accepted and not concluded (a multi-flight flight or final inherits its parent economic event).
- An event that was never accepted (unknown id, or terminal before install) returns `accepted:false,
continuation_active:false`.
- `capability_versions`: `capability_id -> rule_version` of every available capability at acceptance. Empty (`{}`)
  for events backfilled at install, whose versions were never recorded.

Event kinds: `tournament` today. The CHECK is extensible; a new kind ships with its own acceptance writer.

## 4. The continuation rule for commerce (binding)

1. A commerce access check (plan, trial, renewal, entitlement, seat or diamond balance of the operator) that would
   block an operation on an existing event **MUST allow it while
   `fn_event_continuation(kind, id).continuation_active` is true.** An event accepted while the operator was properly
   authorized runs through its conclusion even if the trial or renewal lapses in between.
2. Commerce **MUST NOT create a new event** on the basis of continuation. Continuation never authorizes a new
   tournament, a new flight that was not already accepted as a descendant, a re-entry into a concluded event, or
   any other new acceptance. New events are authorized by commerce's own current checks.
3. Continuation never waives security, legal, funding, responsible-gaming, freeze/maintenance or integrity rules.
   It only removes the commercial access check.
4. When commerce goes live it records its plan/trial reference in `accepted_event_operations.authorization_basis`
   through its own server-owned function at acceptance. Until then every acceptance reads
   `{"operator_access":"legacy_free", "recorded_by": "acceptance_trigger" | "install_backfill"}`.

## 5. Where the records come from

- `public.accepted_event_operations` (PK `event_kind, event_id`; no foreign key to `tournaments` by rule).
- AFTER INSERT trigger `trg_tournaments_record_acceptance` writes the row in the same transaction as the tournament;
  a failure to record it fails the tournament insert. `accepted_by` is `auth.uid()` (NULL for service/recurring
  spawns). `parent_event_id` is `tournaments.parent_tournament_id` at insert (NULL in production until multi-day
  ships; `trg_tournaments_refuse_unbuilt_multi_day` refuses a parent today).
- AFTER UPDATE OF status trigger `trg_tournaments_record_conclusion` records `completed`/`cancelled` the first time
  the status becomes COMPLETED or CANCELLED. No other status concludes an event.
- Install-time backfill covered every tournament in ANNOUNCED, REGISTERING, LATE_REG, RUNNING or COMPLETING.
- These are acceptance records, not money. Nothing here moves a chip or a diamond.
- `fn_event_continuation` is `service_role` only because its answer carries `club_id`/`union_id` for any event id,
  which the tournaments SELECT policy hides from non-members. Commerce checks run server side (engine or a SECURITY
  DEFINER RPC), which can call it. Widening it to `authenticated` needs a membership check in the function first.

## 6. How readiness advances

Only through `public.fn_set_capability_readiness(p_capability_id, p_readiness, p_rule_version,
p_expected_revision, p_evidence jsonb) RETURNS jsonb`, never by hand-editing the table (service_role has SELECT only).

- Callers: `service_role`, or platform staff per `public.fn_is_platform_admin()`. Anyone else: 42501.
- Optimistic concurrency: pass the `revision` you read. A stale revision is refused with SQLSTATE 40001
  (`CAPABILITY_REVISION_STALE`); re-read and decide again.
- Unknown id: P0002 (`CAPABILITY_UNKNOWN`). Unknown readiness: 22023.
- `excluded` can be neither entered nor left through the writer (55000); exclusion is an owner decision made in a
  migration.
- `deployed` and `production_verified` require a non-empty evidence object (22023 `CAPABILITY_EVIDENCE_REQUIRED`);
  the table CHECK enforces the same for any write. Suggested evidence keys: `pull_requests`, `commits`,
  `installed_migrations` (versions as recorded in `supabase_migrations.schema_migrations`), `workflow_runs`,
  `engine_release`, `client_build`, and for `production_verified` the live observation (query, time, result).
- Every transition bumps `revision`, replaces `readiness_evidence` with the new evidence and appends one row to
  `public.platform_capability_events` (append-only: UPDATE, DELETE and TRUNCATE are refused by trigger, for the
  owner too).
- Idempotent: repeating the call that produced the current revision (same target, same expected revision, same
  evidence) returns the current row with `event_recorded:false` and writes nothing. Asking for exactly the current
  state is also not an event.
- Stepping back (for example `deployed` to `tested` after a rollback) is allowed and needs no evidence.

Typical advance: a capability's migration or release lands, the delivering agent records `deployed` with the PR,
merged SHA and installed migration version; after it is seen working on live traffic, `production_verified` with
the observation. `club.membership_cap` moves to `deployed` when the membership cap migration is installed.
