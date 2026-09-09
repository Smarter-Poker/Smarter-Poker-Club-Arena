# 2026-09-09 — The union law was checking a location, not a behaviour

`fn_union_law_selftest` raised a **critical** financial alert at 00:20 UTC with
one breach: `tournament_buyin_rake_not_club_scoped`.

## The law is not breached

Tournament buy-in rake is still club-scoped on both registration paths. What
moved is where the code lives.

The check demanded two markers in the **entry point's own body**:

```sql
WHERE n.nspname='public' AND p.proname=r.fn
  AND p.prosrc LIKE '%rake_records%'
  AND p.prosrc LIKE '%fn_tournament_entry_split%'
```

Since it was written, the maintenance-freeze and atomic-lifecycle programmes
each wrapped the registration entry points in a gate. The entry points are now
thin delegators and the split lives further down:

```
fn_register_for_tournament (68 chars, an overload shim)
  -> fn_register_for_tournament(uuid, boolean)                320 chars
    -> ..._before_maintenance_announcement_gate             1,716 chars
      -> ..._before_atomic_lifecycle_gate                     770 chars
        -> ..._before_atomic_capacity_20260907   10,993 chars  <- BOTH MARKERS

fn_register_horse_for_tournament                              301 chars
  -> ..._before_maintenance_gate               6,963 chars     <- BOTH MARKERS
```

A false positive on a money law is expensive twice: it costs somebody an
investigation, and it teaches the next reader to discount the alarm. That is
CLAUDE.md 10.84's lesson — a check nobody can trust is not a check.

## The fix

Follow the delegation instead of assuming the location. From each entry point
the check now walks every function in that entry point's own name family which
the body actually names, to a depth of eight, and asserts the markers appear
somewhere reachable. It survives the next gate being wrapped around the entry
point — which is the thing that keeps happening — and it still fails if the
split is genuinely removed.

## Verified both ways before shipping, read-only against production

- **Positive**: `law_reachable = true` for both entry points, chain sizes 4 and
  2, so both terminate.
- **Negative**: substituting a marker that does not exist makes **both** false.
  A self-test that cannot fail is the failure mode that matters, and this one
  can still fail.
- After applying: `fn_union_law_selftest()` returns `healthy: true`, breaches
  empty, and the other sixteen checks are intact (the migration asserts four of
  them by name and aborts if any went missing in the edit).

The two `financial_alerts` rows are resolved with that reasoning recorded on
them, per CLAUDE.md 10.9.

## Noted, not changed

The self-test also returns a standing **warning** — not a breach —
`distribution_exceeds_rake`: `rake_collected 0.00`, `total_distributed
120,942.76`. A collected figure of exactly zero alongside a large distributed
figure looks like a window or scoping artefact in the warning's own query rather
than real over-distribution, but it has not been traced and is not part of this
change.
