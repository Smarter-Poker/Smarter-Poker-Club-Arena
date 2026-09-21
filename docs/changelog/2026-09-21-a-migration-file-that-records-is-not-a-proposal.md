# A migration file that records is not a proposal

2026-09-21. Issue #5008.

## The finding

PR #5007 restored 14 migration files into the parity gap and **held 8 back**,
because four checks refuse a file whose only purpose is to RECORD a migration
production already ran. The previous agent declined to edit four security
checks to admit its own files, and it was right to.

Two of the four refusals are false in the present tense, read from production:

- `check-definer-authorization` calls 11 functions browser-executable.
  `has_function_privilege('anon', ...)` is **false for all 11**; every live ACL
  is `{postgres=X, service_role=X}`. The file's creation-time grants were
  superseded by a later revoke sweep. The check reads migration text, not the
  catalogue, so it cannot see that - and for a NEW migration its conservative
  reading is right.
- `check-money-trigger-declared` calls 2 triggers undeclared. Both are rows in
  `ca_declared_money_triggers`, live and enabled. It reads the file and never
  the register.

The other two are structural:

- `check-no-new-band-aids` refuses `fn_tournament_payout_reconcile`, which
  CLAUDE.md 10.9 names as the platform's own idempotent path and which is
  already in `docs/BAND-AIDS-REGISTER.md` - merely absent from the allowlist.
- `a-declared-guard-change-is-recorded-not-raised.law` pardons an undeclared
  guard redefinition only through a bound list, and an entry needs the
  SUCCESSOR MIGRATION'S FILE. The plausible successors are themselves inside
  the parity gap. **The mechanism is unreachable from inside the gap it exists
  to close.**

## The shape

One defect with four faces: **a check treating an added migration file as a
prediction about what production will become, when the file is a record of what
production already is.**

Every question these four ask - will a browser reach this definer, is this
trigger reviewed, is this a repair path, is this guard change declared - is a
question about a change that has not happened yet. For a migration that ran on
2026-09-12, all four are answered by rows in production, and refusing the file
does not undo anything. It only keeps the change out of source control, which
is the exact gap `Applied Migrations Are Recorded` exists to shout about.

## Measured

Read from `supabase_migrations.schema_migrations` on 2026-09-21:

|                                            | count     |
| ------------------------------------------ | --------- |
| applied migrations, any version shape      | 4,825     |
| well-formed 14-digit versions              | 4,751     |
| with recordable (non-empty) statements     | 4,399     |
| **with no file in EITHER estate repo**     | **2,460** |
| of those, at or after the 2026-08-25 floor | 874       |
| empty statements (unrecoverable)           | 425       |
| non-14-digit versions (incl. `manual`)     | 74        |

The 491/477 figures in #5008 were measured from a narrower floor; this is the
whole ledger, counting a file in Club Arena **or** the World Hub as recorded,
since the two share one migration ledger.

## The distinction

`scripts/ci/recorded-migration.mjs`. A file is a RECORD when

```
sha256(file, trailing newlines stripped)
  == sha256(rtrim(array_to_string(statements, E'\n'), E'\n'))
```

for the row production holds at that version. Anything else is a PROPOSAL and
is judged exactly as before.

**Why this cannot be forged.** It is not a marker, a header, a promise or an
allowlist entry - it is a falsifiable statement about a row in production. To
satisfy it for a migration production has NOT run you would have to run it
first, at which point the file is a record, the security question is already
moot, and refusing it removes the record rather than the danger. One byte
different - a fixed typo, an added header, a "harmless" extra GRANT - and it is
a proposal again, which is the correct answer, because an edited record is not
a record.

**The digests are read from `origin/main`, never the working tree**, so a pull
request cannot add its own pardon: the copy in its own diff is ignored. Same
reasoning as CLAUDE.md 10.8 and `tests/unit/doctrineIsReadFromMain.test.ts`.
`scripts/ci/installed-migration-digests.d/<YYYYMM>.txt` is generated from
production by `gen-installed-migration-digests.mjs`; it is sharded by month so
two months written independently cannot conflict (10.9 rule 9), and it holds
only versions with no file in either repo, so **it shrinks as the gap closes**.

**COULD NOT TELL is its own outcome** (10.86 rule 1). An unreadable manifest is
printed and every file is judged as a proposal. Failing closed is the only safe
direction: the cost of judging a record as a proposal is one blocked file; the
cost of the reverse is an unjudged migration.

## The forgeable marker is closed

`check-definer-authorization` carried a 2026-09-01 exemption that skipped any
file whose FIRST LINE matched `-- BACKFILLED`. The intent was right and the
proof was not: a marker is text, so a genuinely new migration with that line
pasted on top walked straight through a security gate. It is now a hint that
produces a better error message, never a pardon. Only the digest pardons.

## What is pinned

`tests/a-migration-file-that-records-is-not-a-proposal.law.test.ts`, 13 tests.
For each of the four checks: a byte-exact record is taken out of its hands, and
a genuinely dangerous NEW migration is still refused. The dangerous fixture is
one file carrying all three offences at once - a SECURITY DEFINER writer with
default (browser-reachable) grants that never consults `auth.uid()`, an
undeclared trigger on `table_seats`, and a repair-named function - and each
check's own exported judgment is asserted to still catch it.

Also pinned: the digest arithmetic matches the SQL side; a marker is not proof;
an unreadable manifest is a proposal and says so; an unreadable FILE is judged
rather than skipped; the working tree is not consulted (behaviourally, by
writing a shard into it and proving it is not seen); and every shard on disk is
well formed and machine-generated.

## The reader

`applied-migrations-recorded.yml` - the trusted twice-daily job that already
holds the service role - now runs the generator with `--check` and fails, with
an error annotation, when the committed shards disagree with production. It
does not commit: that job is `contents: read` on purpose, and the `main`
ruleset has `bypass_actors: []`, so no workflow can push to main either. A
refresh is a pull request, exactly as the schema manifests work.

## Ordering

The checks read the digests from `origin/main`, so the shards have to BE on
main before a record file can be recognised. This change therefore lands first
and carries no migration files; the 8 held-back files follow in their own pull
request. That ordering is not an inconvenience to route around - it is the
anti-forgery property doing its job, and any shortcut that let this branch
pardon its own files would be the allowlist edit #5007 rightly refused.

## The other 2,452

See the recommendation in the pull request and in
`docs/BAND-AIDS-REGISTER.md` - in short: the 874 at or after the floor are
worth recording (they are the live schema), the 62 inside the 7-day hand-history
window are already covered by the ordinary flow and need nothing special, the
425 with empty statements cannot be recovered and should be recorded as stubs
naming what is unknown rather than invented, and the 74 odd versions including
`manual` should be left alone and excluded by shape, which the generator
already does.
