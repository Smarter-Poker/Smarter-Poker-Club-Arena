# The test accounts are swept

**2026-09-05.** Dan: "DELETE ALL THE TEST ACCOUNTS."

121 machine-generated accounts removed. 9 that matched the same patterns were
kept, deliberately, and so were 10 horses that live on a `.test` domain.

## The set

Identified by address shape only - never by a name that merely reads like a
test:

| pattern | what it is |
| --- | --- |
| `%@probe.smarter.poker` | websocket probes |
| `%@smarter-poker.invalid`, `%@example.invalid` | certification markers |
| `%@yopmail.com` | disposable mailboxes |
| `club-arena-%e2e%@smarter.poker` | end-to-end suite accounts |
| `tester_<uuid>@test.com`, `god_<uuid>@test.com`, `logotest_<n>@example.com` | generated fixtures |
| `test@example.com`, `jetski_test_123@example.com` | named fixtures |

```
matched the patterns                     130
kept: on the ledger or the audit trail     9
─────────────────────────────────────────────
deleted                                  121

chips held      0.00     hands played      0     live seats        0
clubs owned        0     card purchases    0     diamonds held 8,500
```

## What was kept, and why

**Ten horses.** `angelo`, `bigtony`, `dom`, `frankie`, `joey`, `mickey`,
`nicky`, `paulie`, `sal` and one more sit on `@midwayunion.test`, and every one
of them is a HORSE. CLAUDE.md 10.5 - "HORSES ARE NEVER EVER DISCLUDED BY DESIGN
ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!" A `.test`
domain is not a licence to delete a player. `fn_sweep_test_account` refuses any
horse outright, so the pattern list cannot reach one even by accident.

**Nine accounts that are on the money record.** They appear in
`chip_ledger.performed_by` having together moved **1,600,000 chips**, and in
`audit_trail.actor_id`. Both columns are `NOT NULL`, so there is no way to keep
those rows while removing the account - the only way through would be to delete
the ledger and audit rows themselves. That is not a tidy-up, it is erasing the
record of 1.6M chips moving, and those nine accounts are the answer to "who
moved them". CLAUDE.md 10.9: *never edit history quiet.* An account that has
acted on the chip ledger has stopped being disposable.

## What the probe found

The first draft was a plain `DELETE` plus an audit table of my own. Probing it
against production (CLAUDE.md 11.5 - one call, one self-aborting `DO` block)
refused it twice, for two reasons that reading the schema would not have shown.

**1. The diamond journal is append-only.**

```
P0403: DELETE on diamond_transactions is forbidden: financial journals are
append-only. Corrections are new linked rows (category=correction). Set
app.ledger_maintenance with an incident reference for authorized maintenance.
```

`diamond_transactions` cascades from the account. Seven of the 121 hold journal
rows - 7 rows, 3,500 diamonds, every one a house credit (`bonus` /
`reconciliation`, source `phase41_audit`), **zero spend rows**.

`fn_ca_journal_append_only` supplies the path itself: with
`app.ledger_maintenance` set to an incident reference it copies each deleted row
whole into `ca_diamond_journal_archive` with the reason attached, logs the
bypass in `ca_ledger_mutation_log`, and raises a DR5 incident per row. Its own
comment names this exact caller - *"The diamond journal is deleted from on an
hourly cadence by the certification fleet."* Taking that path is following the
rule, not routing around it: nothing is destroyed, and the rows come out with
better provenance than they went in with.

**2. Five cascade targets carry `zz_freeze_guard`.**

`wallets` (120 rows for this set), `club_members`, `chip_transactions`,
`wallet_transactions` and `table_seats`. The probe ran at 17:56 UTC, inside the
`:55` maintenance break (CLAUDE.md 13), and every one of those deletes would
have been refused as the *next* failure - after 121 accounts had already been
removed. The migration now refuses to start while `fn_platform_frozen()` is
true rather than half-completing, and says to re-run between `:00` and `:53`.

**3. Two AFTER DELETE triggers emit a row *about* the account.**

```
23503: insert or update on table "daily_challenge_dashboard_revisions"
       violates foreign key constraint ..._user_id_fkey
       Key (user_id)=(325c1e26...) is not present in table "profiles"

23503: insert or update on table "game_management_events"
       violates ..._recipient_id_fkey
       Key (recipient_id)=(325c1e26...) is not present in table "users"
```

`user_daily_challenges` and `challenge_streak_state` bump a dashboard revision
on delete; `club_members` emits a management-access event. Reached by the
cascade, all three fire in a world where the account is already gone, and their
inserts die on their own foreign keys.

The first instinct - patch each trigger to skip a missing user - is the wrong
shape. It is N patches to platform triggers, discovered one round-trip at a
time, to fix something that is not really broken. The fix is **ordering**:
delete those child rows FIRST, while the account still exists. Every trigger
then runs in exactly the conditions it was written for - the same ones a real
player leaving a club produces - and the rows they emit are themselves
`ON DELETE CASCADE`, so the final delete carries them away. **No platform
trigger needed changing.**

**4. The emitted event then blocks the delete that caused it.**

```
55000: Game management events are append-only
```

Deleting the membership emits a `game_management_events` row naming the
account as recipient; that table is append-only too, so the row this
transaction just created blocks the account delete. Circular.
`fn_guard_game_management_event` permits a `DELETE` when `auth.uid() IS NULL`
and `app.game_management_retention = 'on'` - the retention path, gated to
callers that are not a browser session. A migration is exactly that, and the
only rows removed are the ones this same transaction emitted, about a
membership ending as part of deleting the account that held it. Nothing
predating the sweep is touched.

## Read this before you call a drifting counter a bug

The passing probe reported club chips falling **66.81** and `chip_ledger`
growing **62 rows** - alarming for a set measured at `0.00` chips. It was not
the sweep. A control run of the identical measurement shape with **no deletes
at all** drifted more:

```
club chips  171658901.09 -> 171658679.59   -221.50
chip_ledger      1599341 ->      1599364        +23     in three seconds
```

That is live play seen through `READ COMMITTED`, where every statement takes a
fresh snapshot. Any platform-wide total measured either side of a slow loop on
this database moves on its own. Scope assertions to the rows you touched.

## The audit table I deleted

The first draft created `test_account_sweeps` to record each removal. It was
redundant. `profiles` already carries `trg_ca_profile_deletion_journal`, which
on every profile delete:

- writes the profile into `ca_profile_deletions` (870 rows already - this path
  is well travelled),
- archives its whole diamond journal into `ca_diamond_journal_archive`,
- and **burns the balance out of `ca_mint_ledger`**, so diamond supply stays
  honest when 8,500 diamonds leave with these accounts.

A second competing record would have been strictly worse than the one the
platform already keeps. Deleted before applying.

## What shipped

One function, `public.fn_sweep_test_account(uuid)`, and one call of it per
account. The guards live inside the function so they travel with the code
rather than sitting in a `WHERE` clause in a migration nobody reads twice. It
refuses:

- a horse,
- an account holding club chips, a live seat, or a club it owns,
- an account with a real-money `diamond_purchases` row,
- anyone in `chip_ledger.performed_by` or `audit_trail.actor_id`,
- any address outside the pattern list,
- any call made while the platform is frozen,

and it is idempotent - a second run returns `already_removed` and changes
nothing. `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ...
TO service_role`.

The migration ends with a verification block inside its own transaction: zero
sweepable accounts may remain, and the horse fleet must still read exactly
1,000. If either fails the whole thing aborts.

Migration: `supabase/migrations/20260905174801_the_test_accounts_are_swept.sql`


## What the apply returned

```
profiles                1310 -> 1189    121 removed
horses                  1000 -> 1000    untouched
audit_trail             2373 -> 2373    untouched
test accounts remaining              9  the ledger nine, kept on purpose
ca_profile_deletions     876 ->  997    121 recorded
ca_diamond_journal_archive              7 preserved, tagged with the sweep reason
ca_ledger_mutation_log                  7 bypasses logged
```

8,500 diamonds left the platform with these accounts and were burned out of
`ca_mint_ledger` by the profile trigger, so supply stays honest.
