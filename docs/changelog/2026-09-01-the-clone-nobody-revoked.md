# The clone nobody revoked

2026-09-01. One live hole closed, and the gate that should have caught it
before it merged taught to read the shape that walked past it.

## What was open

`fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)` decides which
club a player is seated under. It was:

- `SECURITY DEFINER`, owned by `postgres`, so it runs past RLS;
- `proacl` = `{=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}`
  -- the leading `=X` is PUBLIC;
- 2,779 characters of body containing neither `auth.uid()` nor `auth.role()`.

So it could not know who was calling, and it took the player to be looked up as
a parameter. Handed any user id and any table id, it answered a caller with no
account at all: which club that player is currently seated under in this union,
which clubs they are an active member of, and the order they joined them. It
reads `table_seats`, `club_members`, `union_clubs` and `profiles` as the owner,
so no row-level policy was standing behind any of that.

Established by reading `pg_proc`, `pg_policy`, `pg_constraint` and `pg_index`.
It was never called. Nothing in the schema depends on it as a policy helper,
and no file in the repository names it.

## How it got there, which is the part worth keeping

`20260901090000_club_card_human_realtime_stats.sql` needed three functions
duplicated under new names, so it read each definition with
`pg_get_functiondef`, rewrote the name in the text, and `EXECUTE`d it:

```sql
IF to_regprocedure('public.fn_join_club_membership_impl(uuid)') IS NULL THEN
  SELECT pg_get_functiondef('public.fn_join_club(uuid)'::regprocedure) INTO v_def;
  v_def := regexp_replace(v_def, 'FUNCTION public\.fn_join_club\(',
    'FUNCTION public.fn_join_club_membership_impl(', 1, 1);
  EXECUTE v_def;
END IF;
```

Two of the three clones were revoked from `PUBLIC, anon, authenticated` in that
same file. The third was not. `CREATE FUNCTION` grants `EXECUTE` to `PUBLIC` by
default, so the omission is not neutral -- it is the open state.

The author knew the rule. They applied it twice in the same block, and revoked
the wrapper this clone was copied from four lines earlier. What failed was the
gate: `scripts/ci/check-definer-authorization.mjs` reads `CREATE FUNCTION`
statements, and a clone is not spelled `CREATE FUNCTION`, so there was no
declaration to judge and the migration passed clean. The daily live audit found
it hours after it shipped, which is the right backstop and the wrong moment.

## What changed

**The hole.** `20260901120000_the_seat_club_clone_is_not_an_anon_reader.sql`
revokes the clone from `PUBLIC, anon, authenticated` and grants `service_role`,
matching the treatment its two siblings got. Safe because the only caller
anywhere is `public.fn_seat_club_for_user`, which is itself `SECURITY DEFINER`
owned by `postgres` and therefore calls the clone as `postgres`. The migration
asserts that in its pre-flight -- if the wrapper ever stopped being definer, or
lost its own grant, the migration refuses rather than breaking seating.

Live afterwards: `anon` false, `authenticated` false, `service_role` true;
wrapper untouched at `authenticated` true, `service_role` true. The daily audit
went from `EXIT=1, anon-readable functions: 8 (1 new)` to `EXIT=0,
anon-readable functions: 7 (0 new)`.

**The gate.** A third rule: a name a migration clones into must have its grants
stated. There is no "the body consults `auth.uid()`" exemption available to a
clone, because the body lives in the database and not in the file -- either the
migration says who may execute the new name, or it does not ship. Clone targets
are read as the names spliced into a `'FUNCTION public.<name>('` literal, minus
every name handed to `pg_get_functiondef`, which is the source being copied.

Run against the migration exactly as it was proposed in #2400, today's gate
exits 1 and names `fn_seat_club_for_user_membership_unchecked`, and nothing
else.

**A second bug, found while writing the first.** The gap between `GRANT`/
`REVOKE` and `ON FUNCTION` was matched with `[\s\S]*?`, so the word "grant"
anywhere at all reached forward to the next `ON FUNCTION` in the file and
stamped its own verb on somebody else's statement. It really happens: that same
migration ends with

```sql
RAISE EXCEPTION 'Deep Stack Society still has a duplicate opening owner-wallet grant';
```

and that lone word turned the next `REVOKE` into a `GRANT`. Here it read
stricter than the truth, which is the harmless direction. Reversed -- a stray
"revoke" ahead of a real `GRANT` -- it clears a function that is wide open,
which is the exact failure the file exists to prevent. The gap is `[^;]*?` now,
so a verb stays inside its own statement.

## Pinned

- `tests/unit/theSeatClubCloneIsNotAnon.test.ts` (6) -- the migration revokes
  PUBLIC as well as the roles, asserts its own outcome, names the exact
  signature, checks the wrapper survives, and no browser path calls the clone.
- `tests/definer-authorization-gate.test.ts` (30, was 24) -- the clone rule
  driven against the real migration, plus the statement-boundary regression.
  Both new groups were proven red by seeding the revert they guard: with the
  old `[\s\S]*?` gap restored, two of them fail and the rest stay green.

---

## Everything else this pass turned up

The hole above was found by the daily audit. Looking for what else was open on
the way to closing it produced four more, and each one is a guard that had
stopped guarding.

### main was red, and the bundle had stopped publishing

`tests/engine-watchdog-asks-production.test.ts` asserted the sentence the engine
watchdog printed while it waited: `inside the ${GRACE_MIN}m grace window`. #2446
gave the engine a restart schedule and replaced that message. The grace window
itself survived, as the floor under the new schedule deadline, but the pin went
red -- and `npx vitest run tests/` is the step that PUBLISHES the Club Arena
bundle, so the World Hub sync had been failing on every commit since. Production
was serving a bundle from 12:03 while `main` moved six commits ahead.

A pin on wording fails when the wording improves and passes when the behaviour is
deleted, which is backwards. It reads the arithmetic now: the window is defined,
measured from the commit, can only ever push the deadline later, and being inside
it returns before the ENGINE BEHIND warning.

### the recorder was wrong about one gap in five

`check-applied-migrations-are-recorded` reports migrations that ran against
production with no file here. Its key is the name, deliberately. But the stamp
turns up INSIDE the name: an author who applies
`20260825_perf_rakeback_stats_batch_set_based` and commits a file called exactly
that was reported as missing, because the file name was read as everything after
the stamp while the applied name still carried it.

426 reported, 87 of them with the file sitting right there. Both sides are
normalised now and the report falls to 365. An alarm that is wrong a fifth of the
time is one people learn to scroll past, and those 365 are real.

Its preconditions also moved out of module scope: a check that calls
`process.exit(2)` on import cannot be read by a test.

### the audit now runs hourly

The definer-exposure job is the only thing on this estate that can see a grant
made outside a migration, and almost all schema here is applied that way. At one
run a day, a function that ships anon-executable at 09:00 answers strangers until
05:20 the next morning. Both of the last two findings -- `fn_collect_bounty`,
which pays knockout bounties, and the clone above -- had been live for hours.

Hourly at :40. The manifest refresh in the same workflow stays daily and skips
that cron by name, because a refresh pull request every hour would bury the one
thing here that needs a person.

### the estate agreed on one file again, and disagrees on one more

`estate-integrity.sh` requires fifteen files to be byte-identical across all
seven repositories, and issue #2190 has been reporting two of them drifting.

`agent-autopilot.yml`: #2396 rewrote nine workflows here "to fix non-existent
github action versions", with no body and no failing run cited, moving this one
from `actions/checkout@v7.0.1` to `@v4` and `create-github-app-token@v3` to `@v1`.
Both versions exist -- v7.0.1 published 2026-07-20, six weeks before that PR --
and the other six repos have been running exactly those two on this workflow
every ten minutes, green, throughout. Restored; the file now hashes identically
to the estate copy.

`agent-workspace.sh`: Club Arena was ahead, with a warning that says how stale a
REUSED worktree is. That one is a real improvement and belongs everywhere, so it
was copied verbatim into the other six (one PR each).

`AGENT-PLAYBOOK.md` is left alone deliberately, and is the one item here for Dan
rather than for an agent. Club Arena's copy carries a RULE 0 about em dashes and
M-bar artwork, added by #2436, which the other six do not have. The rule is
Dan's and is already binding in `CLAUDE.md` section 10.7 and pinned by
`tests/unit/noThreeBarArtwork.law.test.ts`. Making the seven agree means either
pushing a Club-Arena-specific artwork law into PepNationLab and the Commander
repos, or removing Dan's own words from a file. Neither is an agent's call to
make quietly, least of all on the rule that has already been misread twice.
