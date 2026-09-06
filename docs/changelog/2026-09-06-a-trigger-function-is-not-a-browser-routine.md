# 2026-09-06 - A trigger function is not a browser routine

`main` was red on three workflows. Two were the same finding from two angles,
and two of its three causes were mine.

| workflow                        | at    | says                                                               |
| ------------------------------- | ----- | ------------------------------------------------------------------ |
| Telemetry Exposure              | 20:22 | "A browser can execute an unscoped SECURITY DEFINER routine"       |
| Schema Manifest Refresh         | 21:40 | "Ask production which DEFINER writers a browser can reach"         |
| Applied Migrations Are Recorded | 21:26 | "Production has applied migrations that this repo has no file for" |

## The definer exposure

Both of the first two ask **production**, not the repo, which SECURITY DEFINER
routines that write are executable by a browser role and never consult
`auth.uid()` / `auth.role()` / `auth.jwt()`. Asked directly, production named
three — all **trigger functions** holding `EXECUTE` for `authenticated`:

- `fn_ca_alert_resolution_reaches_the_incident` — mine, `20260906113923`
- `fn_ca_incident_resolution_reaches_the_alerts` — mine, `20260906113923`
- `fn_sync_profile_total_hands` — pre-existing

`CREATE OR REPLACE FUNCTION` on this database hands `EXECUTE` to
`authenticated` by default, and the `[autorevoke]` event trigger that strips
`PUBLIC`/`anon` does not strip `authenticated`. The repo-side gate,
`check-definer-authorization.mjs`, deliberately skips anything
`RETURNS trigger` — and its reasoning is correct, because Postgres refuses to
call a trigger function outside a trigger context, so the grant cannot be
exercised. The production-side auditors make no such exemption. So a genuinely
inert grant still turned `main` red, which is exactly the "check nobody can
act on" that CLAUDE.md 10.83 is about.

Firing a trigger does not check `EXECUTE` on its function, so revoking costs
the triggers nothing. Verified after applying, with a probe that rolled itself
back: resolving an alert still closes its incident (`resolved`), and resolving
an incident still closes its alert (`true`). Fixing two of three would have
left the check red and taught everyone to ignore it, so the pre-existing one
is closed here too. Production now reports **zero** unscoped DEFINER writers
reachable from a browser.

## The unrecorded migrations — reported, not absorbed

`Applied Migrations Are Recorded` is red because production holds **2,470**
applied migrations with no file in this repo, of a total 3,699 with a 14-digit
version. Fifteen of them were applied today by other agents (`20260906163151`
through `20260907000000`).

None are mine — all fourteen of this session's migrations have committed
files, checked one by one. This is a long-standing estate-wide condition and a
2,470-row reconciliation is its own piece of work with its own decisions; it
is named here rather than quietly half-fixed.
