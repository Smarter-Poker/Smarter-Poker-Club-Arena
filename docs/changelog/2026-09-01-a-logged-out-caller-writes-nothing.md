# A logged-out caller writes nothing, and two writers share one version

Date: 2026-09-01
Branch: `fix/anon-cannot-write-a-club-message`

Found by reading why `Schema Manifest Refresh` had been red since 17:26 UTC.

## What was wrong

Its first job is the live definer-exposure audit, and the audit was right:

```
[definer-exposure] A LOGGED-OUT CALLER CAN EXECUTE A WRITING FUNCTION.
  fn_set_club_lobby_message(p_club_id uuid, p_message text)  executable by anon
```

`20260902113000` intended to prevent exactly this and ended with

```sql
REVOKE ALL ON FUNCTION public.fn_set_club_lobby_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ... TO authenticated;
```

That is the wrong idiom on Supabase. New functions in `public` are granted
EXECUTE to `anon`, `authenticated` and `service_role` **explicitly**, not
through `PUBLIC`, so revoking `PUBLIC` removes a grant that was never doing the
work and leaves `anon` holding EXECUTE. The audit prints the correct form, and
it names `anon` for this reason.

The function does check `auth.uid() IS NULL` and refuse. That is not the point,
and the audit says so: the 2026-08-28 rebuy hole was a guard that read
`auth.uid()` and skipped itself when there was none, and the only thing between
that and a live exploit was a grant exactly like this one.

## The cost was not only the hole

The exposure audit is the first job in `schema-manifest-refresh.yml`, and the
`refresh` job runs behind it. With the audit red, the schema snapshot had not
refreshed since 17:26 either — so every agent since had been hand-writing
manifest fragments against a stale snapshot, with 30 pull requests open. One
wrong grant was costing the whole estate.

## The second defect, found while fixing the first

`clubs.lobby_message` has two writers:

| Writer                                                  | Version aware                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `fn_save_club_identity_messages_versioned` (Phase 5)    | reads `message_revision` FOR UPDATE, refuses on mismatch with `version_conflict`, bumps it |
| `fn_set_club_lobby_message` (the owner's daily message) | wrote the same column, never touched `message_revision`                                    |

So the legacy path was invisible to the compare-and-swap. An operator with the
Phase 5 panel open held a revision that was still "current" after somebody else
had rewritten the message underneath them, saw no conflict, and overwrote it on
save — precisely the overwritten-draft failure Phase 5 exists to prevent,
reintroduced by a sibling writer.

`fn_set_club_lobby_message` now takes the same `FOR UPDATE` lock and bumps
`message_revision`. Who may write, and what they may write, is unchanged. The
panel now correctly reports `version_conflict` and reloads.

## Applied and verified

`20260902230000_a_logged_out_caller_writes_nothing.sql`, applied to production
and recorded. Live grants are now `authenticated`, `service_role`, `postgres`
— no `anon`. The audit that was failing CI now reports:

```
anon-executable writers: 0 (must be 0)
```

## Left for Dan, deliberately not decided here

The two writers disagree on the length of the same column. `fn_set_club_lobby_message`
caps at 240 ("the width the modal shows in full" — Dan's daily-message feature).
The Phase 5 identity panel caps `lobby_message` at 72 and calls it a one-line
identity message. Today nothing is affected: 17 clubs have a message and the
longest is exactly 72, so no data is at risk and nothing needs truncating. But
they are two different ideas of what this column is, and picking one is a
product decision rather than a migration.

Related open issue: **#2573**, "Definer sweep phase 2: verify-or-revoke the
remaining 271 browser-executable definers". This fix is one instance of that
sweep; so is `20260902223000`, which revoked `fn_admin_close_table` from
`authenticated`.
