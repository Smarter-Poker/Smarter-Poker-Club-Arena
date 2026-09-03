# 2026-08-31 - Phase 3's definer-view fix reopened in eight hours

## What came back

Phase 3 cleared every `security_definer_view` ERROR and swept 40-odd views to
`security_invoker = true` in `20260831e_every_definer_view_respects_the_caller`.
Eight hours later the advisor reports two again:

```
public.v_spin_draw_distribution_7d   SECURITY DEFINER, anon SELECT, authenticated SELECT
public.v_ca_suspense_balance         SECURITY DEFINER, anon SELECT, authenticated SELECT
```

Both owned by `postgres`, so they read **past RLS with the owner's rights for a
caller with no account**. One is the spin game's own draw distribution; the
other is the net settlement-suspense balance.

Across the estate: 52 views we own, **4 missing the option, 2 of those readable
by a browser role.**

## The sweep was never the fix

`20260831e` said so itself - _"naming views one at a time loses that race by
construction: this estate gains views faster than a migration can list them"_ -
and then fixed the moment rather than the mechanism. A sweep is a snapshot. The
next `CREATE VIEW` reopens the hole, and that is exactly what happened, inside a
single working day.

## The guard, in the estate's own idiom

Three `ddl_command_end` event triggers already make the safe thing automatic
here:

```
trg_rls_on_new_public_table
trg_autorevoke_privileged_anon
trg_strip_client_writes_from_new_views
```

`trg_new_view_respects_the_caller` is their sibling. A new view in `public` that
we own and that does not already say `security_invoker` gets it stamped, with no
migration and nobody remembering.

**Termination.** The `ALTER` fires `ddl_command_end` again; on that pass the view
HAS the option, the condition is false, and it stops. The guard depends on a
state it can itself produce - which is exactly the property an earlier fix in
this estate got wrong and looped forever on. One extra pass, then quiet.

**Excluded on purpose:** materialized views (they do not support
`security_invoker`) and views we do not own (PostGIS and Supabase internals are
not ours to re-permission - the trap that aborted the first phase-3 run).

## Checked before touching anything

Neither view is referenced by application code in either repo - only by the
schema manifests and a changelog - so flipping them to invoker cannot break a
product surface.

## Proved, not assumed

The post-apply block creates a throwaway view **inside the same transaction**,
reads back its `reloptions`, and drops it:

```
POST-APPLY: 0 owned views without security_invoker;
            a new view is stamped automatically
```

If the trigger had not fired, that assertion would have failed and the whole
migration would have rolled back. The probe view is dropped in the same
transaction on purpose - the 2026-08-25 incident left three `zz_probe*`
functions in `public` and needed a second migration to remove them.

Applied as `20260831154230_a_new_view_respects_the_caller_without_being_asked`.
Verified live: `still_missing 0`, `guard_enabled 1`.

## Noticed while verifying, not actioned

`public` holds three leftover backup tables from another agent's 2026-08-30
tournament-reopen work - `zz_reopen_20260830_backup`, `zz_reopen2_...`,
`zz_reopen3_...`, 32 kB each. They are **not** an exposure: RLS is on with zero
policies, so they are deny-all, which is `trg_rls_on_new_public_table` doing its
job. Housekeeping for whoever owns that work, not a hole.
