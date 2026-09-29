# Production Integrity Audit: four red jobs, two causes, two fixes

2026-09-22. `Production Integrity Audit` had been failing on `main` with four
red jobs (run 35802840468 and every run before it back to the 21st). They are
not one defect. Diagnosed separately below, with the verdict for each.

## 1. `Live drift and BBJ rebuild coverage remain clean` - THE REPOSITORY WAS WRONG

**What it measured.** Four live-drift readers; three were clean. The fourth,
`check-anon-definer-grants.mjs`, compares production's real grants against
`docs/security/anon-executable-definers.json` and found one function anon may
execute that the repository has not accounted for:

```
realtime=0 bbj_rebuild=0 cosmetics=0 anon_definers=1
   fn_shared_bonus_replay(p_share_id uuid)
```

**What was true.** Read from production: the function is `SECURITY DEFINER`,
`has_function_privilege('anon', ...)` is `true`, and its ACL is
`{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.

The grant is deliberate. Migration `20260919153418` makes it, and its own
postcondition **raises if it is absent** - a shared replay link is meant to
open for a logged-out visitor. The written decision already exists twice: in
`public.ca_browser_definer_allowlist`, and in the `anonPublicSurface` list of
`scripts/ci/definer-authorization.allowlist.json`.

**The cause: two lists describe one fact and nothing made them agree.**

| list                                                          | read by                                                    | when                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `definer-authorization.allowlist.json` -> `anonPublicSurface` | `check-definer-authorization.mjs`, from the migration text | pre-push and PR CI, **before** the merge |
| `docs/security/anon-executable-definers.json` -> `allowed[]`  | `check-anon-definer-grants.mjs`, against production        | hourly, **after** the merge              |

The migration author added the first - it was the list standing between them
and a green push. Nothing they could run locally mentioned the second, and the
job that did notice writes to an issue, not to a check anybody had to clear.
This is CLAUDE.md 10.84's engine-01 shape exactly: lists that had to agree,
with nothing checking them.

**Fixed.** The entry is added, with a reason saying precisely what an
unauthenticated caller learns (a random share UUID, one immutable prize
snapshot, no identity, wallet, club, seed, enumeration or write). Pinned by
`tests/unit/theTwoAnonDefinerListsAgree.test.ts`: every name the static
allowlist blesses must be accounted for in the live manifest. It needs no
database and no credential, so it runs wherever `tests/` runs - `.husky/pre-push`,
PR CI, and the `npx vitest run tests/` gate inside `publish-club-arena.yml`.

**The named reader is the author of the branch that adds the grant, at the
moment they add it** - the only moment the fix is cheap. Verified by removing
the entry: the pin goes red and names the function.

It deliberately does not check the other direction. The live list holds
long-standing grants no branch declares, and the static list "starts EMPTY on
purpose"; requiring the reverse would demand grandfathering the whole existing
public surface into a list whose point is that each entry costs a paragraph.

## 2. `Every merged migration is live` - PRODUCTION WAS WRONG

**What it measured.** 1,499 migrations at or after `20260902000000` against
`supabase_migrations.schema_migrations` and the live catalog. Eight are merged
and not live. Seven are from 2 - 8 September and are the standing backlog also
described by issues #5008 and #4130. The eighth is new and is the one that
matters:

```
20260922143541_club_and_union_diamond_commerce.sql
   missing 14 tables, 16 indexes, 4 triggers ...
```

Confirmed directly against production: `ca_commerce_purchases` does not exist,
`fn_ca_commerce_claim_due_renewals` does not exist, and there is no
`20260922143541` row in `schema_migrations`. It was merged at 16:09Z on
2026-09-22 as PR #5077 and never applied.

**The cause: the pre-merge gate answered a question it had not asked.**
`check-migrations-applied.mjs` exists to stop exactly this. Run against the
merge base it says:

```
3 changed migration(s) vs 0662cc2a3b^; 0 unapplied object(s).
OK - every object these migrations declare exists in the live schema.
```

Its parser is fine - it finds all 14 tables and 35 functions. It reads
`loadSchemaManifest`, which is the nightly base snapshot **unioned with every
`scripts/ci/schema-manifest.d/*.json` fragment**. The base is generated FROM
the live schema, so a name in it was seen in production. A fragment is a line
the branch author typed. Unioned, the two are indistinguishable, and the gate
reported a promise as a fact. The fragment's own `_owner` field read
"Applied as 20260922143541". It had not been.

This is CLAUDE.md 10.86 rule 2: an answer that could not be read was coerced
into a good one.

**Fixed at that line.** `loadSchemaManifest` now returns `promisedTables` and
`promisedFunctions` - the names present _only_ because a fragment says so - and
`check-migrations-applied.mjs` keeps three outcomes apart:

- **OBSERVED** - in the base snapshot. Production was asked. Silent, as before.
- **PROMISED** - fragment-only. Reported by name with the file that promised
  it, under "NOTHING HAS ASKED PRODUCTION, so this gate cannot tell whether
  they are live". Never described as existing in the live schema.
- **ABSENT** - in neither. Exit 1, unchanged.

Where a credential already exists in the environment, it stops guessing: with
`SUPABASE_DB_URL`/`DATABASE_URL` set it looks the promised names up in the live
catalog and an absent one is a hard exit 1 with the true reason. A URL that is
set but unreadable is **exit 2, COULD NOT TELL** - measured, not assumed:

```
EXIT=2
[check-migrations-applied] COULD NOT ASK THE DATABASE.
   A connection string was set, so silence here would be a lie. This is not a pass.
```

The script never contains, derives or prints a credential (10.84), and a test
pins that.

**PROMISED does not block, deliberately.** The fragment mechanism exists so a
branch can reference an object it HAS applied before the nightly base
regenerates; 75 tables and 214 functions are legitimately mid-promise on `main`
as this is written. A gate that refused them would wedge every migration author
on the estate, which is worse than the staleness it reports - the same ruling
CLAUDE.md 10.87 makes about the freshness guard. What the change removes is the
CLAIM, not anyone's ability to ship.

**Named readers.** The branch author, at pre-push and in PR CI, now reads
"NOTHING HAS ASKED PRODUCTION" naming their own migration file instead of "OK -
exists in the live schema". Stated honestly: the credentialed mode is dormant
today, because neither `ci.yml` nor `.husky/pre-push` supplies a database URL to
this step. It is a correctness upgrade for wherever one is supplied, not a new
reader I am claiming. The reader that already catches the live condition is the
hourly `Every merged migration is live` job, which did its job correctly here.

The commerce fragment's `_owner` field is corrected: it claimed the migration
was applied, which misled every later reader (10.86, "put an expiry on any
claim").

**`ci.yml`'s step summary still says "exists in production", and is left
alone on purpose.** That sentence re-asserts the claim this change removed, so
correcting it was the obvious third edit. `.github/workflows/ci.yml` is a
byte-pinned cash qualification input (`scripts/ci/test-cash-failure-pgcron.py`,
`load_inputs`), and re-stamping that pin means asserting the cash qualification
still holds - a claim about money-path CI that a three-line wording change has
not earned. The gate's own stdout, which the summary block prints directly
beneath that line, now carries the truth. Anyone re-qualifying cash should take
the sentence with them.

**Not done here, and why.** Applying `20260922143541` is the remaining half and
it is not mine. It is 126 KB of commerce and wallet logic I did not author;
there is no path from this session to `apply_migration` that does not involve
retyping it, and a transcription error in a money path is not recoverable
(CLAUDE.md 11.5 rule 5: if you cannot run it safely, say plainly that it was
reasoned about rather than executed). The owning task for PR #5077 applies it.
The audit names it every hour and the nightly `schema-manifest-refresh` will
name it too.

## 3. `The engine is running main` - PRODUCTION WAS WRONG, AND THE CHECK IS RIGHT

```
main needs : 0662cc2a (2026-09-22T16:09:00Z)
engine has : 8825af51817f379c4261658ca29ecc9d8d81932d
```

**This is not the maintenance break.** A gap between `main` and the running
engine is expected for part of every hour (CLAUDE.md 13), and a check that
reported that as a failure would be an alarm that is always on. That is not
what this is: the ledger's last shipped release is **2026-09-18T21:57:13.904Z**,
four days and 43 attempts ago. No tolerance or break-window awareness was added
to `audit-engine-provenance.sh`. Blunting a check that is correctly reporting a
four-day outage would be the 10.84 mistake in the other direction.

Players are not affected: the supervisor is holding the sealed release,
`/health` reports `releaseSha 8825af51` and `handsInFlightTotal 147`.

## 4. `The engine pipeline is not starving` - PRODUCTION WAS WRONG, AND THE CHECK IS RIGHT

```
43 consecutive engine release attempts have shipped nothing over 5707.9 minutes.
   39 x the durable Hetzner release transaction did not complete
    4 x the release sealed but production identity could not be independently proved
```

Read from `ca_engine_deploy_attempts` directly. The threshold (>= 3 attempts
AND >= 120 minutes) is derived from 94 measured episodes and written beside the
number; 43 and 5,708 are far outside it. The check is working exactly as built,
including its "I could not tell" outcome. Nothing was changed.

**The cause is named and it is not in this repository.** 39 of the 43 are the
condition issue **#4649** already describes: `engine-01` has roughly 100 MiB
free and the bounded engine build budgets 1.15 GiB, so the release transaction
cannot complete. The 44th attempt failed differently and for the reason in
section 2 - `Prove The Exact Engine Has Every Production Door` refused it
because `fn_ca_commerce_claim_due_renewals`, `fn_ca_commerce_deliver_due_notices`
and `fn_ca_commerce_execute_renewal` are called by
`server/src/services/CommerceRenewalConsumer.ts` and do not exist in production.
That gate is correct and is the first true thing anybody was told.

So applying the commerce migration is necessary and **not sufficient**: the
memory condition on `engine-01` is the dominant cause and has to be read on the
box, through the owning path, by whoever owns the engine-restart programme
(`docs/HANDOFF_CURRENT_STATE.md`). Issues #4649 and #4219 are open and name it,
so this finding has a reader; a second issue would be noise.

## What was deliberately not done

- **No repair job, sweep, retry, backfill or watcher** (10.11, 10.12). Nothing
  here repairs anything; two guards stopped lying and one list gained a row.
- **`production-integrity-audit.yml` keeps its single write path.** It still
  cannot retry, dispatch, open a pull request, toggle a workflow or publish
  (CLAUDE.md 1.1). Not one line of it changed.
- **No check was weakened.** The one behaviour removed is a false claim.
- **The seven older merged-but-not-live migrations** are untouched: they are
  the subject of open issue #5008, whose fix is a change to three security
  guards that explicitly "should not ride along underneath" other work.
- **No engine or maintenance-break constant was touched**, so nothing here
  needs a cutover window.
