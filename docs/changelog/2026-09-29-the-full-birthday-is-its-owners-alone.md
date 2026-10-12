# 2026-09-29 - A player's full birthday is theirs alone

Found on the Club Arena app's device walkthrough. From a fresh account's own
session on the emulator, `GET /rest/v1/profiles?select=id&birthday=not.is.null`
returned every profile with a birthday on file, and a range filter narrows any
player to the exact day. `authenticated` held a column SELECT grant on
`profiles.birthday`; the profile-privacy lockdown had revoked `age_verified`,
`email`, `phone`, the `kyc_*` and `jurisdiction_*` columns and
`over_18_attested_at`, and missed this one. The World Hub's stranger-profile
allow-list carried it too, so every public profile view fetched the subject's
date of birth.

## The change

Migration `20260929040431_the_full_birthday_is_its_owners_alone` revokes
`SELECT (birthday)` on `public.profiles` from `authenticated` (and from `anon`,
which never had it). INSERT and UPDATE are untouched, so signup, the World Hub
profile editor and `fn_set_my_birthday` still write it. `birth_year` stays
readable on purpose (the World Hub profile page shows "Born In <year>").

It declares `@live-proof` lines for `check-migrations-are-live.mjs`: SELECT is
gone for both roles, UPDATE is still there for `authenticated`.

## Why it waited for two other changes

Postgres refuses a whole statement that names one ungranted column, so every
reader had to stop naming it first - otherwise the revoke would have taken the
readers down with it (the World Hub's 2026-09-03 "User Not Found" outage was
exactly this):

- the app's age gate now asks `fn_my_age_gate_status()` (#5564);
- the World Hub removed `birthday` from `SAFE_PROFILE_COLUMNS`, live before
  this was applied; its editor reads the owner's row through
  `get_my_full_profile()`, and the birthday reward runs as `service_role`;
- in the 24 hours of API logs before applying, the only requests naming
  `birthday` in a select were the walkthrough's own.

## Applied and verified

Applied 2026-09-29 04:04 UTC (outside the :50-:03 break window) after the
World Hub change was confirmed live (`/api/health` reported its merge commit
`0ec88f4f`). The MCP recorded it as version `20260929040431`, which the file
now carries. Checked right after, from the app's own signed-in session on the
emulator:

| Request                                                   | Before         | After                                    |
| --------------------------------------------------------- | -------------- | ---------------------------------------- |
| `profiles?select=id&birthday=not.is.null`                 | 206, every row | 403 42501                                |
| `profiles?select=birthday&id=eq.<own id>`                 | 200            | 403 42501 (own reads go through the RPC) |
| a stranger's profile with the World Hub's new column list | -              | 200                                      |
| `rpc/fn_my_age_gate_status`                               | 200            | 200 `{ ok: true, verified: true }`       |
| `rpc/get_my_full_profile`                                 | 200            | 200, still carries the owner's birthday  |

In SQL: `has_column_privilege('authenticated', 'public.profiles', 'birthday',
'SELECT')` is false, `UPDATE` and `INSERT` are still true.
