# The legacy inventory and the clean-day series

2026-10-04. Two of Phase 12's twelve lines can be built before the release
happens, and this change builds them. Nothing was deleted, no runtime code,
routing, workflow or configuration was touched, and production was read only.
Both arena switches were `false` throughout and still are.

Two documents:

- [`docs/audits/2026-10-04-diamond-legacy-symbol-inventory-and-url-retirement.md`](../audits/2026-10-04-diamond-legacy-symbol-inventory-and-url-retirement.md)
  for the line "Search both repositories and deployment configuration for every
  inventoried legacy symbol/path".
- [`docs/audits/2026-10-04-diamond-clean-accounting-release-series.md`](../audits/2026-10-04-diamond-clean-accounting-release-series.md)
  for the line "Verify existing clean-accounting release prerequisites with
  actual time-series evidence".

Neither programme checkbox is ticked here. The phase's deletions and its release
steps are still ahead, and the second document's verdict is that one part of the
gate is not met.

## Two names in the retirement list are load-bearing

The Phase 2 inventory lists `fn_ca_arena_diamonds()` as a "legacy balance reader"
to retire and `fn_ca_arena_seat_is_same_asset()` as a "legacy reporting trigger".
Production says otherwise.

`fn_ca_arena_diamonds()` is called by `fn_ca_diamond_trial_balance` and
`fn_ca_diamond_snapshot`. It sums `poker_diamond_custody.balance` plus open
`diamond_spin_days.pending_diamonds`, which is the arena float, and it is an
argument to the trial balance that the release gate reads. `fn_ca_diamond_offledger_float`
opens with `IF to_regprocedure('public.fn_ca_arena_diamonds()') IS NULL THEN
RETURN 0`, so dropping it does not raise: the off-ledger float silently becomes
zero while `fn_ca_circulation_total` and `fn_snapshot_chip_supply` keep excluding
Diamond custody on the stated grounds that this function counts it. The float
would leave the books in both directions and the trial balance would keep reading
clean.

`fn_ca_arena_seat_is_same_asset()` is the only function in the database whose
body contains `DR15:cross_asset_seat`, and DR15 is in `refuse` mode since
2026-09-22. Dropping it puts DR15 into the rule-with-no-consumer state that
migration `20260919223115` had to repair for DR16. Its trigger is also
`AFTER INSERT FOR EACH ROW` on `table_seats`.

Both are reclassified from retirement target to live. The two doors that **are**
deletable, `fn_arena_deposit` and `fn_arena_withdraw`, have zero callers in `src/`
or `server/` and are named only in `fn_guard_profile_privileged_columns()`'s
allowlist, which has to lose those two entries in the same forward migration.

## The journal classes are not the functions

`arena_deposit` and `arena_withdraw` are also `diamond_transactions.type` values,
and `fn_poker_diamond_reserve` writes `arena_deposit` today. Seven live functions
write or classify `arena_withdraw`, and the World Hub's `DiamondWalletModal.jsx`
labels both for the player. A deletion pass that grepped for the string would
take the label off every live Diamond receipt.

## A third repository, a dead project and a live DNS record

The Phase 2 inventory has no entry for the standalone application. It exists:
`Smarter-Poker/Smarter-Poker-Diamond-Arena`, cloned at `~/Documents/diamond-arena`,
last commit 2026-08-19, pointed at the production Supabase project.
`.github/scripts/estate-integrity.sh` already records it as a parked repository
with no active publisher, and its own PR #64 deleted its autopilot workflows.
Its Vercel project returns `404 Project not found`.

`diamond.smarter.poker` still resolves, to Vercel addresses `216.150.1.193` and
`216.150.1.65`, while no Vercel project claims it. `curl` returns
`DEPLOYMENT_NOT_FOUND`. A subdomain pointed at a shared platform with no project
behind it is the one item in this inventory with a risk attached. Removing the
record is Dan's action.

## The old URLs are clean, proved past the status code

Thirteen URLs read with `curl -L`. Every one 404, every one with
`num_redirects=0` and `url_effective` equal to the request. `/hub/diamond-arena`
returns the App Router not-found page and the only occurrence of `diamond-arena`
in its body is the router echoing the requested path segments. No iframe element,
no reference to the retired host. World Hub `vercel.json`'s redirects are two
`/Portfolio` entries; `next.config.js`'s `redirects()` was read end to end and
has no diamond entry; `middleware.ts` names no diamond route. The only live
reference to the retired host left anywhere is `next.config.js:738`, an
`images.remotePatterns` permission to load an image from a host that serves none.

## Four live surfaces still describe the old arena

`pages/legal/official-rules.js` carries a "Diamond Arena Sweepstakes" programme
and promises "Free Roll Hourly Tournaments: Enter The Diamond Arena Every Hour
With ZERO Entry Fee". `pages/terms.js` says "Prize Redemptions Enabled" and calls
the arena "Competitive Training Challenges". `pages/hub/help.js` says the arena is
a poker room where you can play cash games and tournaments. `pages/auth/signup.js`
treats it as a sibling of Club Arena. Both switches are off and the guarantee and
promotional-entry decisions are Phase 9's open owner lines, so three of these four
are economics (CLAUDE.md 10.9) and none was changed here.

## The clean-day series does not show seven clean days

The gate, from `DIAMOND-ACCOUNTING-ROADMAP.md:197`, is "seven consecutive days of
`fn_ca_diamond_trial_balance` at 0 on every account, suspense 0, and no open
critical `ca_diamond_incidents`". The series starts 2026-09-04, when the hourly
watch began; there is nothing before that.

The trial balance has named no broken account on any hourly tick since
2026-09-12 00:20 UTC, 22 complete days, and `ca_diamond_snapshots.unexplained`
has been 0.00 throughout. Suspense has filed nothing since 2026-09-07 17:20 UTC,
and because `fn_ca_diamond_trial_balance_watch()` tests suspense in the same pass
that writes the hourly summary row, every `incidents_filed: 0` is a positive read
rather than an absence. Those two parts are met with room to spare.

The third is not. The only run of seven or more consecutive clean days in the
whole record is 2026-09-21 to 2026-09-28, eight days, and it ended on 2026-09-29.
Since then: 23 criticals on 09-29, 23 on 09-30, 3 on 10-01, all horse-claim rows,
resolved together on 10-01; clean on 10-02; one critical on 10-03; clean so far
today. The current run is one complete day strictly, four on the most generous
end-of-day reading. The gate reads met at this instant and has not read met for
seven days.

## The 45 rows were the record, not the money

45 `DR0:health_critical` rows were filed between 2026-09-09 07:35 and 2026-09-11
15:35 and all 45 were resolved at one instant, 2026-09-20 14:10:11.98905+00, by
the first pass of `20260919223032_the_health_watch_resolves_what_it_filed`. Their
notes read "area trial balance read ok", not "fixed now". Nothing was filed on
the nine days in between, the last trial-balance break was 2026-09-11 15:20, and
unexplained movement went to zero on 2026-09-12 and stayed there. The cause was
fixed on the 11th, the books were clean from the 12th, and the rows stayed open
for nine days because nothing could close them. The first countable day after the
resolver ran is 2026-09-21, because 2026-09-20 itself carried those 45 open for
fourteen hours.

## October 3 was the scheduler

The one critical on 2026-10-03, filed 19:35 and resolved 21:35, says "Trial
balance is incomplete: require one known comparison for each of the five
reconciling accounts", status `unknown`. The trial balance did not break; it
correctly refused to answer, which is CLAUDE.md 10.86 rule 1 working. What broke
was pg_cron: across the whole database the 20:00 hour ran 268 jobs against a
normal ~800, and three separate Diamond watches each lost a tick, including the
20:20 trial balance.

Three hours in the last four days produced no trial-balance reading at all:
2026-10-01 00:20 failed with `job startup timeout`, and 2026-10-01 23:20 and
2026-10-03 20:20 never fired. A missing reading is "could not tell", and nothing
in the estate turns it into a named outcome: the per-day count simply reads 23
instead of 24 with no flag. The gate's own evidence has a measurement gap with no
reader. That is recorded, not fixed, because fixing it is a change to a watch and
this was an audit.

## Also corrected

The release manifest records two F06 migrations as unapplied.
`20260918232558_mixed_f06_custody_transfer_retains_original_operations` is now
applied; `20260919024039_unresolved_f06_custody_retains_its_lease_evidence` is
still not.

The canonical World Hub clone at `~/Documents/Smarter-Poker-World-Hub` is 19
behind and 1 ahead of `origin/main`. A commit on local `main` is what jams a
clone (CLAUDE.md 10.87 rule 3). Both documents were built from `origin/main`
through `git show` and `git grep`, so the finding does not affect them, but
somebody should look at that commit.
