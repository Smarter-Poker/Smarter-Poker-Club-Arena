# Two red audits: the ledger the repo could not write down, and the estate finding nobody could act on

2026-09-22. `Applied Migrations Are Recorded` (run 35791676660) and
`Estate Integrity` (run 35795190980) were both red on `main`. They are
unrelated in mechanism and identical in shape: each had measured something
true and each had become unactionable, one because the repair was refused and
one because the report did not say who had to make it.

## 1. The migration ledger

### What the audit measured

`scripts/ci/check-applied-migrations-are-recorded.mjs --fail`, scheduled twice
a day, asks the direction no pull-request gate asks: of everything production
has APPLIED in the last seven days, what has no file in this repo. On
2026-09-22 it answered **40 of 226**.

### What was actually there

The audit's count is correct and its wording is one word short. Measured here
against `origin/main` and against all 708 remote branches:

|                                                            | count |
| ---------------------------------------------------------- | ----- |
| applied since 2026-09-15                                   | 226   |
| no file on `main`                                          | 40    |
| ...of those, present on a live feature branch, in flight   | 18    |
| ...of those, **present nowhere in this repository at all** | 20    |

Eighteen are ordinary concurrency: an agent applied a migration and its pull
request has not merged yet. Twenty are not. The oldest,
`20260916111614`, ran against production six days ago and exists in no branch,
no pull request and no worktree. A rebuild from this repo would not have any
of them.

### Why the gap never closed

Issue #5008 had already diagnosed it, on a different set of files, and the
diagnosis holds: **the repo cannot be made to match the database, because
writing down what the database already has is refused.** Reproduced today on
this set. All twenty files were recovered byte-exact from
`supabase_migrations.schema_migrations.statements` and offered to the local
guards. **Ten of the twenty are refused.** Not by one guard - by four rules
across three of them:

| refused by                                                                                      | versions                                                                                       |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| definer, writer rule (`SECURITY DEFINER`, writes, browser-reachable, never asks who is calling) | 20260917034153, 20260917034226, 20260917044635, 20260917054616, 20260917062322, 20260922162135 |
| definer, anon rule (reachable without an account)                                               | 20260916111614                                                                                 |
| money-trigger (an undeclared trigger on a money table)                                          | 20260917060339, 20260917181100                                                                 |
| band-aid (10.12)                                                                                | 20260920070556                                                                                 |

Each of those three guards reads the migration files a branch ADDS and asks
"is this introducing something unreviewed". For a file recording a migration
that ran six days ago the question has a different answer, and refusing the
file does not prevent the change - the change is live. It only prevents the
record. Issue #5008 measured this at eight files; on a fresh set six days
later it is ten out of twenty, so it is not a one-off backlog, it is the
steady state.

### What this change does

It settles the ten the guards do not refuse. Every one is byte-exact to
what ran, proved by md5 against
`md5(convert_to(array_to_string(statements, E'\n') || E'\n', 'UTF8'))`:

| version        | md5                                | name                                                                       |
| -------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| 20260917024440 | `02e2be56b811e3df501966ed39e7aa4a` | production_alert_identity_and_rake_wording                                 |
| 20260917034208 | `fe03086534417a5dcac59b2dc0a7cbbf` | production_alert_rake_repair_record_evidence                               |
| 20260917072941 | `95cda46d5c95d2f5489fed531dfa216a` | direct_operational_source_legacy_envelope                                  |
| 20260917123908 | `e302600763a477f28a8a2a11bc0540f3` | spin_history_retention_until_canonical_terminal                            |
| 20260919142126 | `86629b7f39fbd3b2ebb7707c33fb61c2` | the_waitlist_listener_can_hear_a_seat_open                                 |
| 20260920143152 | `4dc6541aeb52caf131c824fc8e800608` | the_ledger_speaks_to_the_player                                            |
| 20260921183648 | `d814dbec74d6ab4c9b6e4497b651cada` | club_data_exports_expire_at_the_door                                       |
| 20260922123913 | `e04219cdd4598bcad90903c74837a1e6` | an_abandoned_generation_hand_is_voided_from_rows                           |
| 20260922132301 | `50cb4b935b82b96ee73988221ba5d6eb` | the_agent_breakdown_asks_was_it_paid_once_per_stretch                      |
| 20260922132318 | `8f90b16c0a6931236fe52e8351f92fd8` | a_late_chair_a_bought_addon_and_a_foreign_park_do_not_hold_an_event_frozen |

Nothing was applied, altered or re-run. These are records of live schema; the
database was read and never written.

### What is deliberately NOT here

The ten refused files, and the guard change that would let them land.

Fixing three security guards is the highest-risk edit in this repository and
#5008 says, correctly, that it should not ride along underneath the
restoration it unblocks. So the ten are held back, recoverable at any time
from the same source, and recorded on #5008 with their md5 and the exact rule
that refused each:

| version        | md5                                | refused by                       |
| -------------- | ---------------------------------- | -------------------------------- |
| 20260916111614 | `a8fd7cff9a35f11b7f34320de30148cc` | definer, anon rule               |
| 20260917034153 | `bdba79c846468fe7f24ca4c058bd8230` | definer, writer rule             |
| 20260917034226 | `eaa1e69a786bf719372b26e913449673` | definer, writer rule             |
| 20260917044635 | `b25799cd9ba9ea7a893793e9d21306e5` | definer, writer rule             |
| 20260917054616 | `fcd8ba24b437fbd4b6349968df267b81` | definer, writer rule             |
| 20260917060339 | `1bbc72c990b860ce4cd92fac9e2b3cc4` | money-trigger (8 triggers)       |
| 20260917062322 | `3b70ba6f45581e952739f89b8808c8ab` | definer, writer rule             |
| 20260917181100 | `546a8026f0529911992c2d8feb5bca95` | money-trigger (`public.wallets`) |
| 20260920070556 | `2b66cf9fa5a458196da957c956ac56e3` | band-aid                         |
| 20260922162135 | `80c94e81b7a8a29f4ab59996b2546428` | definer, writer rule             |

**Read that table as a security finding, not as paperwork.** Seven
`SECURITY DEFINER` writers that a browser role can reach and that never
consult `auth.uid()`, eight undeclared triggers on `table_seats`,
`tournament_players` and `tournaments`, two more on `public.wallets`, and a
minutely reconciler - all of it ALREADY LIVE in production, none of it ever
reviewed, and the only reason anybody knows is that the guards refused the
paperwork. Those are ten separate repairs against live schema and each wants
its own pull request.

### One measurement worth carrying forward

`check-definer-authorization.mjs` took **128 seconds** on the single
1.67 MB migration `20260917181100`, and did not finish in 25 minutes on all
twenty files together. It concatenates every touched migration into one
`branchSql` and then rescans that whole string once per file, which is
quadratic in the branch's total SQL. A guard slow enough to be killed by a
job timeout answers nothing (10.86: a signal that does not answer is not a
signal). Recorded on #5008; not fixed here.

## 2. Estate integrity

### What the audit measured

`.github/scripts/estate-integrity.sh` compares seven repositories: branch
rulesets still in force, fourteen shared guard files byte-identical
everywhere, Autopilot alive, shared file modes executable. It found
**19 problems** and wrote them to issue #3931.

### What was actually there

The nineteen are real, and eleven of them are shared files with 2-6 different
versions each. Measured today, with the last commit date for every variant:

- **Club Arena holds the most recently committed copy of nine of the eleven.**
  `scripts/check-unpushed-work.sh`, `scripts/check-canonical-clone.sh`,
  `scripts/guard-shared-clone.sh`, `scripts/agent-workspace.sh`,
  `.github/scripts/check-token.sh`, `.github/scripts/queue-pr.sh`,
  `.github/workflows/agent-autopilot.yml`, `AGENT-PLAYBOOK.md` and
  `.agents/rules/00-agent-playbook.md`. In those nine Club Arena did not
  drift; the other six repositories are carrying an older copy, in four cases
  from 2026-08-22.
- **Club Arena is the stale one in two.** `.husky/reference-transaction`
  (World Hub committed a newer one on 2026-09-21) and
  `.github/workflows/agent-open-pr.yml` (six different versions, three of
  them newer than Club Arena's 2026-09-11).
- **Two of Diamond-Arena's files are zero bytes.**
  `.github/workflows/agent-autopilot.yml` and
  `.github/workflows/agent-open-pr.yml` both hash to `e3b0c44298fc`, which is
  the sha256 of the empty string. That is not a drifted copy of a workflow.
  There is no workflow.

### The verdict, and what this task did not touch

The drift is genuine and it is in repositories Club Arena has no authority
over: **Smarter-Poker-World-Hub, smarter-poker-commander, commander-shared,
smarter-poker-workers, Smarter-Poker-Diamond-Arena and PepNationLab.** They
are not reached into from here. The same applies to the other eight findings -
three repositories whose Autopilot last run is `completed/failure`, and five
whose shared files are committed 100644 where 100755 is required.

What IS Club Arena's, and is fixed here, is the report. Issue #3931 listed a
digest per repository and nothing else, so no reader could tell whether Club
Arena had drifted or the other six were simply behind - and those are opposite
repairs carried out by different owners. Eleven files sat in that state with
nobody acting on either.

`estate-integrity.sh` now prints the last commit date for every variant, names
the most recently committed one, and lists the repositories carrying something
else. It also says outright when a variant is a zero-byte file, because
"3 different versions" reads as three copies worth diffing when one of them is
nothing at all.

This is strictly more information. Nothing that blocked before stops blocking,
no expectation was relaxed, and a drift is still a drift whichever way it
points. The date is labelled as the weaker signal that it is: a repository can
commit an older file later, so it orders the variants and certifies none of
them. The instruction in the issue body is unchanged - make the repositories
agree; do not assume the newest is right.

## What neither of these is

Neither half adds a job that repairs anything on a schedule (10.12). The
sixteen recovered files are a one-off settlement of damage already done, and
the estate change makes an existing report legible. Nothing new watches,
sweeps, back-fills or re-drives.
