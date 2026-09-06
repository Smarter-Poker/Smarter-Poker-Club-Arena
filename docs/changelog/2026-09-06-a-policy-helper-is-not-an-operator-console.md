# A policy helper is not an operator console

**2026-09-06** — branch `fix/a-policy-helper-is-not-an-operator-console`

`Telemetry Exposure` went red on `main` at 16:29 UTC. The check was right about
what it found. **Its first suggested remedy would have taken the entire public
video feed offline**, and that is the more useful half of this note.

## What it found

Four routines, all of which arrived in the 16:14 video/YouTube schema change:

```
fn_is_video_library_asset_eligible(p_asset_id uuid)                anon + authenticated
fn_is_video_library_lineage_eligible(uuid,text,text,text,text)     anon + authenticated
legacy_transition_eligible(p_post social_posts)                    anon + authenticated
legacy_transition_eligible(p_reel social_reels)                    anon + authenticated
```

They meet the criteria exactly: SECURITY DEFINER, browser-executable, no
identity argument, and they never consult `auth.uid()`.

## Why the first remedy was the wrong one

Read from `pg_policy` before writing anything:

| policy                            | on                     | calls                                                                                     |
| --------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `video_library_public_read`       | `video_library_videos` | `fn_is_video_library_asset_eligible(id)`                                                  |
| `video_posts_public_select_guard` | `social_posts`         | `legacy_transition_eligible(social_posts.*)`, `fn_is_video_library_lineage_eligible(...)` |
| `video_reels_public_select_guard` | `social_reels`         | `legacy_transition_eligible(social_reels.*)`, `fn_is_video_library_lineage_eligible(...)` |

**All four are RLS policy helpers.** A policy expression is evaluated as the
CALLER, so the caller must hold EXECUTE on every function inside it.
`REVOKE ... FROM anon, authenticated` — the first command the check prints —
would have made every anonymous and logged-in SELECT of the public video
library, the social video feed and the reels feed fail with "permission denied
for function". The whole video surface, dark, to close a hole that is not one.

SECURITY DEFINER is also correct for them rather than incidental: a policy
helper that reads the table its own policy protects must not be re-filtered by
that policy, or it recurses.

And what they actually expose is one boolean about a row the caller is already
reading, from an identifier the caller already holds. That is the opposite of
`fn_bbj_unclaimed_shares()`, which took **no** argument and returned every
player owed money — closed this morning in `20260906153953`. Same check, same
verdict, opposite correct answer. The check cannot tell those two apart; a
person has to.

## What was done

`20260906163138` records all four on `ca_browser_definer_allowlist` with the
policy that calls each one named in the reason, so a later reader can verify it
rather than trust it. It is **data only** — three INSERTs, no DDL — so it fires
no `pgrst_ddl_watch` and costs no schema reload, which mattered at 16:31 with
the fleet still recovering from 133 reload-triggering statements in the single
minute 16:14.

The migration refuses to write a reason it has not verified: it aborts if a
named function does not exist, and it aborts if `pg_policy` holds no policy
referencing it. An allowlist entry whose stated reason is false is worse than
no entry, because the next reader believes it.

**These are not my programme's functions**, and the rows say so. They belong to
the video library work and landed fifteen minutes before this file. They are
recorded here because the check was red on `main` and CLAUDE.md section 8 puts
a red main ahead of your own work — not because anybody has decided their final
shape. Each reason ends with "delete this row if they re-scope it": an
allowlist entry that outlives its reason is how an allowlist becomes a place to
hide things.

## The check now says this before it says revoke

`check-telemetry-exposure.mjs` printed the REVOKE first and the allowlist last.
The next person reaches for the first command printed — CLAUDE.md 10.86 rule 4,
"when you fix something, ask what the next person will reach for" — so the
order was itself the defect. It now leads with:

```
BEFORE YOU REVOKE ANYTHING, ask whether an RLS policy calls it.

  select pol.polrelid::regclass as on_table, pol.polname
    from pg_policy pol
   where pg_get_expr(pol.polqual, pol.polrelid) ~* '<name>'
      or pg_get_expr(pol.polwithcheck, pol.polrelid) ~* '<name>';
```

then the allowlist for a policy helper, then the revoke for a genuine console,
then `auth.uid()` scoping for a player's own rows. The check's verdict is
unchanged. Only the order of its remedies, and the sentence that stops the
first one being an outage.

## Files

- `supabase/migrations/20260906163138_four_video_policy_helpers_are_recorded_as_browser_needed.sql` (applied; `fn_ca_browser_reachable_telemetry()` returns 0)
- `scripts/ci/check-telemetry-exposure.mjs` — remedies reordered, policy check added
