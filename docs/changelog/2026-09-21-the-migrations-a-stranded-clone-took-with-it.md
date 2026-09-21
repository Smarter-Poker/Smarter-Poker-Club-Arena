# The migrations a stranded clone took with it

2026-09-21

## What was wrong

Fourteen migrations are applied in production and have no file anywhere in
`origin/main`. The database holds the structure; the only surviving record that
any of it was ever authored is a row in
`supabase_migrations.schema_migrations`.

Twelve of the fourteen were applied on 2026-09-12, the day the canonical clone
`~/Documents/club-arena` jammed. The mechanism is the one written up in
CLAUDE.md 10.87: a commit made directly on local `main` meant every later
`git pull -q --ff-only` refused, silently, so the work that produced those
migrations never left the machine. PR #5004 restored the clone to `origin/main`
and archived what it found to `~/Documents/_agent-backups/canonical-2026-09-21/`.
Restoring the clone is what made these findable; it is also what would have
destroyed the drafts had they not been archived first.

This is the failure `scripts/ci/check-applied-migrations-are-recorded.mjs` was
written for, and it names the cost exactly: a Midway Union master reset rebuilds
from these files, so an applied migration with no file is a hardening production
has and the rebuild does not.

## What was done

Each file is written from `schema_migrations.statements[1]`, which is the
authority here: it is the exact text the database executed. The archived drafts
were used only to identify the set, and they are not the authority - of the
eleven that survived on disk, five are byte-identical to what ran and six are an
earlier or later revision of it. Had the drafts been committed instead, six
files would have described something production does not have.

Every restored file is byte-identical to the applied statement:

    printf '%s' "$(cat <file>)" | md5 -q  ==  md5(rtrim(statements[1], E'\n'))

Seven restored in this change:

| version | md5 | name |
| --- | --- | --- |
| 20260823141355 | 18623bce5d797be1338b23f651164a6a | rabbit_hunt_server_enforced_economy |
| 20260912050321 | f5931e1c5c9cfbd7f71ff68646dc31a9 | the_ladder_is_the_one_the_money_was_paid_by |
| 20260912050353 | 650059637b07be60e7eb115701a8fad7 | a_money_adjacent_post_hand_failure_is_not_info |
| 20260912061735 | 504a28eb315f3282e4a3e61162766cb6 | the_felt_register_is_read_only_and_the_incident_is_closed |
| 20260912101218 | 1b72f54cc0838c531f33a896d70ecac8 | reconcile_pr3449_retired_lane_and_tuner_race_never_applied |
| 20260912102321 | 719e0c9c91a75cc2516880c88be7c719 | revoke_dead_client_write_grants_rls_denied |
| 20260912104716 | 679d9a415928ab6cf10e3342cf4caaee | admin_writes_trust_profiles_not_self_written_metadata |

Seven recovered, proved, and NOT shipped here. The reason is a defect worth its
own section, below:

| version | md5 | name |
| --- | --- | --- |
| 20260912044158 | 386458f2ae200d0580bc350066532a6b | a_function_audited_as_moving_no_money_is_not_undeclared |
| 20260912044609 | c155b17aa405639dd5a192a4a53a3b7f | the_supply_meter_counts_the_pending_addon_float |
| 20260912044823 | aaf89503d03c77c61b04f242ac113a25 | the_rake_rollup_stale_check_counts_both_legs |
| 20260912061157 | cb0f9aa5ebb5dba12015dd6ca0a5f31a | the_felt_may_not_grow_past_what_was_bought_in |
| 20260912093734 | b87827b250aa204637ae869c88eabd81 | a_silence_is_a_failure_the_board_can_see |
| 20260914003624 | d8898394ffb68addc624a412758cfaff | tournament_prize_rounding_contract_v2 |
| 20260912110448 | d522638896a7ccfc4bd55fc688b6553d | a_platform_that_is_not_dealing_is_worth_waking_someone |

**Nothing was applied.** These are already installed; replaying an installed
migration is forbidden, and this is a repo restoration rather than a database
change. No DDL was issued from this session at all.

## How each one was proved to have really run

A history row is not by itself proof that a migration took effect, so the
outcome was read rather than assumed. All 24 functions and all 3 relations the
fourteen create exist in `pg_proc` / `pg_class` today. The four that create no
object at all (they are `DO` blocks, grants, revokes and policy rewrites) were
each read: `20260912050321` is a money repair on one tournament, `20260912061735`
takes client grants off the felt register and closes incident 8b8fe26c,
`20260912102321` is the revoke sweep over 750 tables, `20260912104716` rewrites
the eighteen policies that gated admin writes on
`auth.users.raw_user_meta_data ->> 'role'`, a claim the claimant writes about
themselves.

One deserved the closest look, because its own name says `never_applied`:
`20260912101218 reconcile_pr3449_retired_lane_and_tuner_race_never_applied`. Its
header explains itself - the file it reconciles,
`20260907101200_the_audit_tells_a_retired_lane_from_a_silent_one_and_does_no.sql`,
merged as PR #3449 and was never applied, and this migration carries that body
forward. Both functions it defines are live, so the reconcile itself ran. It is
a legitimate applied migration and it gets a file. No history row was removed.

## Why seven of the fourteen are not in this change

Three pre-push guards refuse them. Each guard reads only the added file and asks
"is this branch introducing something unreviewed" - and none of the three ever
asks whether the file is a RECORD of something production applied nine days ago.
For a restoration that question has a different answer, and two of the three
claims are demonstrably false today:

1. **`check-definer-authorization`** names ten functions as "SECURITY DEFINER,
   anon can execute it", and `fn_ca_incident_notify` under its separate writer
   rule as one "a browser role can execute". Read from the live database instead:
   `has_function_privilege('anon', oid, 'EXECUTE')` is **false for all ten**, `fn_ca_incident_notify` is
   executable by neither `anon` nor `authenticated`, and every one of the
   eleven ACLs is `{postgres=X, service_role=X}` with no PUBLIC and
   no anon entry. The guard is right about the FILE - the default ACL for
   functions `postgres` creates in `public` really is
   `{postgres=X,anon=X,authenticated=X,service_role=X}`, and none of those
   migrations carried a REVOKE - so each function WAS anon-reachable at the
   moment it was applied, and a later sweep closed it. The guard's sentence is
   true about 2026-09-12 and false about today, and it is stated in the present
   tense.

2. **`check-money-trigger-declared`** names
   `zzzzzz_tournament_felt_may_not_exceed_supply` on `table_seats` and
   `tournament_prize_math_contract` on `tournaments` as undeclared. Both are
   already rows in `public.ca_declared_money_triggers`, and both triggers are
   live and enabled. The guard reads the migration file and never reads the
   register it is protecting.

3. **`check-no-new-band-aids`** refuses `20260914003624` for declaring
   `fn_tournament_payout_reconcile`. That function is not new, it is named in
   CLAUDE.md 10.9 as the platform's own idempotent settlement path, and it
   already has its row in `docs/BAND-AIDS-REGISTER.md` (TIER 1 #1, "all applying
   repair doors retired"). It is simply absent from
   `scripts/ci/band-aid.allowlist.json`, so every file that records its lineage
   is refused - including `20260820165242`, which is also in the parity gap.

The shape is one defect, not three: **a guard that judges an added migration
file as a prediction about what production will become, when the file is a
record of what production already is.** It is CLAUDE.md 10.86 in a new costume,
and its effect is that the repo cannot be made to match the database, because
writing down what the database already has is refused.

The fix is not to weaken any of them. It is to give all three one fact they do
not currently have - that a file whose version is already in
`schema_migrations` with byte-identical statements is a RESTORATION - and then,
for a restoration, to consult the live database rather than predict it: live
grants for rule 2, the live register for the trigger rule, the existing register
row for the band-aid rule. A genuinely new migration is not in
`schema_migrations`, so nothing about new work changes. "Could not ask" must be
its own outcome and must keep blocking.

That is a change to three security guards, which is the highest-risk edit
available in this repo and is not something to smuggle in underneath a
restoration that it happens to unblock. It is filed rather than done here, and
the seven files above are recovered, md5-proved and ready for whoever takes it.

## What is still open, stated plainly

`check-applied-migrations-are-recorded.mjs` reports **491** applied migrations
since 2026-08-20 with no file in either repo. This change closes 7 of them; the
seven above account for another 7. The remaining 477 are not this work:

- **299** were applied 2026-08-20 to 2026-08-24, which is the backlog the check
  itself calls archaeology.
- **112** fall between 2026-09-03 and 2026-09-13 with no surviving draft. They
  are the standing drift the `migration-drift` issue already tracks.
- **62** are inside the check's own live seven-day window, and a large share
  carry today's date. Those belong to sessions still running; the check's header
  says plainly that failing other people's in-flight work is an outage of its
  own, and writing a second file for a migration whose author is about to commit
  the first one is churn, not parity.
- **1** is the pseudo-version `manual`.

The fourteen handled here are the ones with positive evidence of being stranded:
a draft in the rescue archive, or an application date inside the day the clone
jammed. That is the line, and it is drawn from evidence rather than from a date
cutoff.
