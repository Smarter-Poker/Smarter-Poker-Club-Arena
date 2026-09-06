# The unclaimed jackpot list was open to every account

**2026-09-06** — branch `fix/the-jackpot-console-was-open-to-every-account`

Found while auditing the Realtime WAL work, in a function that was fourteen
minutes old. Fixed at the cause, and the gate that should have caught it was
fixed too, because the gate had a hole exactly the shape of this defect.

## What was open

`public.fn_bbj_unclaimed_shares()` returns every unpaid bad-beat-jackpot share
on the platform: the player's id, their arena name, the amount they are owed,
the table, the hand number, and the reason their wallet could not be reached.

Its ACL, read live:

```
{postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
```

It is SECURITY DEFINER, so the RLS on `bbj_unclaimed_shares` does not apply. It
takes no arguments, so it cannot be scoped to a caller. It never consults
`auth.uid()`, `auth.role()` or `auth.jwt()`, so it cannot tell who is asking.
**Any account that could log in could list every player owed a jackpot share,
by name and by amount.**

## Nobody was owed anything

Read before anything was written: `bbj_unclaimed_shares` held **0** rows with
`paid_at IS NULL` — 0 distinct players, 0.00 in total. So this is an exposure
defect and not a money defect. Nothing here moves a chip, and 10.9's five
conditions are not in play because there is no settlement to make.

That is luck, not design. The same function on a day with parked shares would
have handed the list to anyone with an account.

## The cause, named rather than guessed

Migration `20260906152640_an_unpayable_jackpot_share_is_parked_not_lost`
created the function and wrote no `REVOKE` and no `GRANT`.

That is not carelessness. It is the documented Postgres default and the single
most common way this happens: **`CREATE FUNCTION` grants EXECUTE to PUBLIC**,
and `authenticated` inherits PUBLIC. Silence is not "closed". Silence is "open
to everyone". `check-definer-authorization.mjs` says exactly this in its own
header — and still did not catch this one, for reasons that turned out to be
the more interesting half of the day.

## The fix

`20260906153953_the_unclaimed_jackpot_list_is_not_a_browser_read.sql`:

```sql
REVOKE ALL ON FUNCTION public.fn_bbj_unclaimed_shares() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_bbj_unclaimed_shares() TO service_role;
```

PUBLIC is named as well as the two browser roles. Revoking a role while PUBLIC
still holds EXECUTE reads as a fix and does nothing — the trap that made an
earlier definer fix a silent no-op, and the reason the checker's rules all test
PUBLIC first.

**Why close it rather than scope it.** There were two honest options: scope it
to the caller (`WHERE u.user_id = auth.uid()`, if a player is meant to see
their own parked share), or close it to the browser entirely, if it is an
operator read. It is an operator read, and that is a finding rather than a
preference: `fn_bbj_unclaimed_shares` has **no caller anywhere** — not in Club
Arena's `src/` or `server/src/`, not in the World Hub's `pages/`, `src/` or
`scripts/` — and its only two executions in `pg_stat_statements` are the audits
that found it. A function no client calls does not need a browser grant.

Nothing an operator can see was reduced. `service_role` is what the engine and
every server-side route use, so the reconciler, the alerting and any future
operator page reach it exactly as before. If a player-facing view of their OWN
parked share is wanted later, the right shape is a second function scoped by
`auth.uid()`, never a grant back to this one.

The allowlist was not used. `ca_browser_definer_allowlist` exists for a definer
a browser genuinely needs, with a written reason. Nothing needs this one, so
recording a reason would have been recording a fiction to silence a check.

Post-checks in the migration assert that no browser role can execute it, that
`service_role` still can, and that `fn_ca_browser_reachable_telemetry()`
returns 0 — the class, not just the instance.

## The gate had a hole exactly this shape

This is the part worth keeping. `check-definer-authorization.mjs` had three
rules and this function slipped between two of them:

| rule                      | judges                                    | why it passed this one                         |
| ------------------------- | ----------------------------------------- | ---------------------------------------------- |
| 1. unauthorised writers   | definers that WRITE                       | it is a read                                   |
| 2. anon-readable definers | definers `anon` can reach                 | it is reachable by `authenticated`, not `anon` |
| 3. unrevoked clones       | functions copied via `pg_get_functiondef` | it is a plain `CREATE FUNCTION`                |

The obvious repair — widen rule 2 from `anon` to `authenticated` — is the wrong
one, and rule 2's own header says why: a great many read-only functions are
legitimately open to a logged-in player, and failing all of them would train
everybody to stuff the allowlist. A gate that cries wolf is a gate that gets
routed around.

So **RULE 4** does not widen rule 2. It names the narrow shape that is never a
legitimate player read, and requires all four conditions at once:

- SECURITY DEFINER, and a browser role can execute it;
- it takes **no arguments** — so it cannot be scoped to a caller;
- it returns **SETOF** or **TABLE(** — so it enumerates rows rather than
  answering one question;
- its body never consults `auth.uid()` / `auth.role()` / `auth.jwt()`.

A parameterless definer returning a scalar (a count, a flag, a name-availability
check) is untouched, and so is any function that takes an argument. Both are the
ordinary shapes of a legitimate logged-in read.

This is the same judgement `fn_ca_browser_reachable_telemetry()` already makes
against the live database, moved to the branch — so the shape is **refused
before it is applied** instead of reported fourteen minutes after. The live
check stays: under 10.11 the net stays and is now expected to find nothing, and
a net that starts finding things again is telling you the cause came back.

### Validated before it was wired in

Nine tests in `tests/definer-authorization-gate.test.ts`, all of them exercising
the verdict function rather than the message, so rephrasing the help text cannot
quietly disarm it:

- the shape that shipped is named;
- it clears once the real revoke is read alongside it;
- revoking `anon, authenticated` while PUBLIC still holds EXECUTE does **not**
  clear it;
- a body scoped by `auth.uid()` passes;
- a function that takes an argument passes (the pin that stops this becoming
  "rule 2 for authenticated");
- a parameterless **scalar** definer passes;
- the `SETOF` spelling is caught as well as `TABLE(`;
- `SECURITY INVOKER` passes, because RLS still applies to it;
- a written decision in `anonPublicSurface` clears it, like the other rules.

Run against all 2,332 migration files in the repo, rule 4 returns 9 hits. Seven
are already closed on the live database, `get_current_settlement_period` (both
overloads) is deliberately allowlisted in the database, and
`get_wallet_balance_totals` is SECURITY INVOKER. No pre-existing work is
blocked; the rule only judges what a branch declares.

## Two false premises fixed in the same checker

Neither was found by reasoning about the code. Both were found by the gate
blocking a push and the block turning out to be wrong.

**1. `RETURNS event_trigger` did not match the trigger exemption.** The regex
was `/RETURNS\s+trigger\b/`, in two places. An event-trigger function is not
callable as an RPC any more than a row trigger is, so both are now
`/RETURNS\s+(?:event_)?trigger\b/`. `ca_log_ddl_event` and `ca_log_ddl_drop`
were being reported as browser-reachable definers on that basis alone.

**2. "No GRANT written" is not the same as "open", for a REPLACE.**
`CREATE FUNCTION` grants EXECUTE to PUBLIC; **`CREATE OR REPLACE` on an existing
function PRESERVES the existing ACL**. The two DDL-logging functions above were
replaced, not created, and their live ACL was already `{postgres, service_role}`
— verified empirically by asking whether a browser role could call them, which
it could not.

The gate was fixed rather than the two functions allowlisted. Allowlisting
myself past a check that was wrong would have left the check wrong for the next
person, and 10.86 rule 4 is exactly about that: a fix that leaves the same trap
one level up has not landed.

## What this cost, and the rule it is filed under

10.11: fix it at the root, a detector is not a fix. The exposure is closed at
the grant, the class is closed at the gate, the gate is pinned by tests, and the
live audit stays as the net. Nothing here is "flagged for review".

## Files

- `supabase/migrations/20260906153953_the_unclaimed_jackpot_list_is_not_a_browser_read.sql` (applied)
- `scripts/ci/check-definer-authorization.mjs` — rule 4, the `event_trigger`
  correction, and a pass line that names all four rules
- `tests/definer-authorization-gate.test.ts` — nine rule-4 cases
