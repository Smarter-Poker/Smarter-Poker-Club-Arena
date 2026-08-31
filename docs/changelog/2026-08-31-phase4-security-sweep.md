# 2026-08-31 — Phase 4: the security sweep, and why most of the scary number was already safe

Agent: Claude (Cowork). Migrations `phase4_close_the_anon_definer_surface` and
`phase4_anon_loses_the_logged_in_surface` applied via Supabase MCP; repo copy
in `supabase/migrations/`.

## What was actually exposed

| surface                                                | before | after                        |
| ------------------------------------------------------ | ------ | ---------------------------- |
| SECURITY DEFINER functions EXECUTE-able by `anon`      | **83** | **22** (19 ours + 3 PostGIS) |
| `v_spin_unfilled_waits` readable by `anon`             | yes    | no                           |
| money-mutating definer RPCs with no authorization gate | 0      | 0                            |

`anon` is a caller with **no login at all**. Postgres grants EXECUTE to PUBLIC
by default and Supabase publishes every `public` function as an RPC, so each of
those 83 was a door somebody left open rather than a door somebody built.

**The real finding:**

```
fn_nit_evictions RETURNS TABLE(user_id uuid, vpip numeric,
                               required integer, hands integer)
```

…and it does **not** consult `auth.uid()`. An unauthenticated caller could
enumerate **per-player VPIP statistics** — who is being watched for nit
eviction, how loose they play, over how many hands. Closed to `anon`, kept for
the logged-in club and admin surfaces that actually use it.

## The 123-that-turned-out-to-be-135 RLS tables: not a hole

135 tables have RLS **enabled with zero policies**, and 70 of those still carry
a `SELECT` grant to `anon` — including money-adjacent ones like
`union_rake_weekly`, `ca_seat_stack_exits`, `tournament_rake_settlements`,
`transaction_idempotency_keys` and `ca_ledger_write_failures`.

That reads alarming and **is the correct secure state**: RLS on with no policy
denies every row to any non-bypass role. Rather than assert that, it was proven
against the live REST API with the publishable key:

```
union_rake_weekly             HTTP 200 []
ca_seat_stack_exits           HTTP 200 []
tournament_rake_settlements   HTTP 200 []
transaction_idempotency_keys  HTTP 200 []
ca_ledger_write_failures      HTTP 200 []
```

The redundant grants were **left in place deliberately**. Revoking them adds a
second lock behind a door RLS already holds shut, but it converts a silent
`200 []` into a `401` — a behavioural change with real breakage risk in any UI
that reads such a table, for zero security gain. Worth doing as defence in
depth one day; not worth doing blind.

## What was deliberately not touched

- **Six functions called from inside RLS policy expressions** —
  `fn_can_view_post`, `fn_club_chat_is_silenced`, `fn_home_is_group_staff`,
  `fn_my_club_ids`, `fn_table_chat_is_silenced`, `is_admin`. A policy is
  evaluated as the **querying** role, so revoking EXECUTE would make every
  `SELECT` on those tables fail outright. This is the single most dangerous
  mistake available in this phase and it was checked for first.
- **The genuine pre-login surface**: username and club-name availability,
  public profile / venue / home-group detail, nearby live games, ads, the
  daily challenge, similar questions, and the three leaderboard functions.
- **`get_home_group_public_detail` and `get_venue_public_detail`** have zero
  client references today, but are named and shaped as anonymous public
  endpoints. Absence from a grep is not proof of disuse.
- **The 624 `authenticated`-executable definer functions.** A blanket revoke
  there would be reckless: that set is most of the product's API. The check
  that matters — `fn_check_ungated_money_rpcs`, money-mutating definer
  functions with no authorization gate — returns **0**.

## The surface grew back within the hour

Minutes after the sweep took the count from 83 to 22, it read **23** again.
`fn_tournament_metrics` had shipped from another agent:

```
RETURNS TABLE(running, registering, overdue_start, stuck_completing,
              seatless_phantoms, unpaid_completed, seat_first_waiting)
```

No `auth.uid()`. A live readout of the platform's **operational failure
counts** — how many tournaments are overdue to start, stuck COMPLETING,
carrying phantom seats, or completed-but-unpaid — readable by anyone with no
account. Not player data, but exactly what tells an outsider when the floor is
degraded. Closed to `anon`, kept for `authenticated`.

**This is the finding that outlasts the 61 doors.** It is not a mistake by that
agent; it is the default doing what the default does. Postgres grants EXECUTE
to PUBLIC on every new function and Supabase publishes it as an RPC, so **every
operator watchdog on this platform is born public unless someone says
otherwise** — and they are being written faster than they are being closed. A
one-off sweep cannot hold this line. The durable fix is a CI check that fails
when a new `public` SECURITY DEFINER function is anon-executable without being
on an explicit allowlist, in the same family as
`check-definer-authorization.mjs` which already guards money-mutating writers.
Recommended as the follow-up; deliberately not bolted on at the end of a
security phase without its own testing.

## Evidence every revoke rests on

For each function closed: not referenced in any RLS policy, not in any view
definition, not called by any SECURITY **INVOKER** function, and not referenced
in `club-arena/src`, World Hub `pages/` or World Hub `src/`. Their only callers
are other SECURITY DEFINER functions, whose bodies execute as the owner — so an
EXECUTE grant to `anon` bought those callers nothing and cost a door.

Trigger functions were included: PostgreSQL checks EXECUTE on a trigger
function when the **trigger is created**, never when it fires, so revoking
cannot break DML.

## Verified against the live API as `anon`, not asserted

| call                               | result                                       |
| ---------------------------------- | -------------------------------------------- |
| `check_username_available`         | **200** `true` — pre-login intact            |
| `get_daily_challenge`              | **200**                                      |
| `fn_global_leaderboard_period`     | **200**                                      |
| `fn_resolve_ads` (real args)       | **200**                                      |
| `GET /tournaments`                 | **200** + rows — RLS and policy helpers fine |
| `fn_nit_evictions`                 | **404** PGRST202 — closed                    |
| `fn_create_club_atomic`            | **404**                                      |
| `fn_search_players`                | **404**                                      |
| `fn_audit_overlays`                | **404**                                      |
| `fn_money_path_reaches_club_scope` | **404**                                      |
| `fn_spin_reserve_owner`            | **404**                                      |
| `v_spin_unfilled_waits`            | **401**                                      |

Platform through the change: 1,432 hands in 10 minutes, settler healthy, union
law healthy, **zero** new critical alerts.

One false alarm worth recording: `fn_resolve_ads` first returned 404 and looked
broken. It was an argument-shape mismatch from calling it with `{}` — with its
real arguments it returns 200. A 404 from PostgREST means "no function matching
that signature **that you may execute**", which conflates "revoked" with
"called wrong", and that is worth remembering before concluding a revoke broke
something.
