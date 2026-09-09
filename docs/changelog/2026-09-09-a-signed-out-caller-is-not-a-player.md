# A signed-out caller is not a player

2026-09-09

## Found by following a red workflow

`Schema Manifest Refresh` had been failing on `main` at its **"No unaccounted
DEFINER writer is reachable from a browser"** job. It comments on issue #3917
each time, so it had a reader - but nobody had gone and read what it was
pointing at.

`fn_definer_exposure_audit()` names five `SECURITY DEFINER` functions a
**logged-out** caller can execute and that **write**. All five are the Diamonds
casino games:

| function              | `IF v_user IS NULL` guard | owner check         |
| --------------------- | ------------------------- | ------------------- |
| `fn_crash_start`      | **no**                    | `user_id <> v_user` |
| `fn_plinko_drop`      | **no**                    | `user_id <> v_user` |
| `fn_wheel_commit`     | yes                       | -                   |
| `fn_wheel_spin`       | yes                       | `user_id <> v_user` |
| `fn_wheel_set_config` | yes (service_role form)   | -                   |

## The exposure

Missing the sign-in guard is only defence in depth on its own. The hole is what
it combines with:

```sql
SELECT * INTO prior FROM public.crash_rounds WHERE commit_id = p_commit_id;
IF prior.id IS NOT NULL THEN
  IF prior.user_id <> v_user THEN
    RETURN ... 'That Round Belongs To Another Player';
  END IF;
  RETURN public.fn_crash_round_result(prior) || ... 'replayed';
END IF;
```

`v_user` is `auth.uid()`, which is **NULL** for a logged-out caller.
`prior.user_id <> NULL` evaluates to **NULL**. NULL is not TRUE, so the refusal
does not fire - and execution falls straight through to the `RETURN` below it.

**A signed-out caller holding a `commit_id` could read another player's round
result.** Identically in `fn_plinko_drop`.

Two things make this worth writing down rather than just fixing:

- **the comparison looks like a guard.** It reads as one in review, and it is
  one - for every caller who is signed in;
- **neither half was visible alone.** The NULL-unsafe comparison is unreachable
  if the sign-in guard is there, and the missing guard is harmless if the
  comparison is NULL-safe. Three of the five siblings had the guard, so the
  pattern looked established.

## The fix

1. `fn_crash_start` and `fn_plinko_drop` refuse a NULL `auth.uid()` in their
   **first statement**, exactly as their three siblings already do. After the
   `commit_id` lookup would be too late - the fall-through it guards is the very
   next branch.
2. Every `user_id <> v_user` in those two **and** in `fn_wheel_spin` becomes
   `user_id IS DISTINCT FROM v_user`. `fn_wheel_spin` was never reachable with a
   NULL, because its guard is already there; it is made null-safe so that a
   later edit which moves that guard cannot silently re-open this.

Both changes are strictly more restrictive. Nothing a signed-in player could do
before is refused now.

### What is deliberately NOT changed

**The grants.** Revoking `EXECUTE` from `anon` is the stronger fix and is
probably right, but it changes what the client can call and belongs with
whoever owns the Diamonds surface. The functions now refuse on their own merits
either way.

It would also have **emptied the audit's `anon_writers` list**, which is the
only thing on the estate that still says these RPCs are reachable at all. A fix
that quiets the detector along with the defect leaves the next grant invisible.

## The assertion that earned its keep

The first attempt at this migration **aborted on its own post-check**. The
targeted replace fixed `prior.user_id <> v_user` and left a second
`c.user_id <> v_user` further down; the post-check counted the survivors and
refused:

```
post-check: 2 null-unsafe owner comparison(s) remain
```

so nothing was applied. The replace is on the bare comparison now. That is the
difference between a migration that checks its own work and one that reports
success having half-done it.

## Pinned

`server/src/tournament/aSignedOutCallerIsNotAPlayer.guard.test.ts` - eight pins,
windows bounded by `sliceDollarQuoted`:

- both entry points are covered;
- the refusal is the FIRST statement, before any read;
- **every** null-unsafe comparison is replaced, not just the first one seen;
- `fn_wheel_spin` is made null-safe too, against the next edit;
- the migration refuses a body that has moved on (five separate assertions);
- both halves are proved afterwards rather than assumed;
- **no `GRANT` or `REVOKE` appears in the SQL** - the audit stays honest;
- one transaction, per the production DDL policy.

## Verification

- Applied to production as `20260909071854`; re-read afterwards:
  `fn_crash_start` and `fn_plinko_drop` both carry the guard, and no
  `user_id <> v_user` remains in any of the three.
- `npx vitest run src/tournament`: **119 files, 1232 tests, all passing.**
- `npx tsc --noEmit` in `server/`: clean.
