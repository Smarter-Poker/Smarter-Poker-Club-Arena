# The mint that is gone stops being reported

**2026-09-11. Phase 6 of 6.**

Continues `docs/changelog/2026-09-11-the-wheel-runs-the-way-the-other-two-do.md`.

Three pieces of dead weight and one missing gate.

## The mint

The games stopped minting chips on 2026-09-10: the host is the house, the
intake goes to its owner and the prize comes out of its promo wallet, and
nothing is created. `chips_minted` has read zero on every round since, and five
read payloads kept handing that zero to the browser, where two service files
typed it, mapped it and carried it into three page states that never printed it.

Only the **reporting** is removed. The columns stay, and so do the writes.

The columns are not empty: 24 rows across `wheel_spins`, `plinko_drops` and
`crash_rounds` carry real historical mints from the weeks when the platform did
mint. Dropping them would destroy the record of the thing this branch spent a
day undoing, which is exactly the record somebody will want.

The writes stay at zero because `fn_spin_chip_conservation_check` and
`fn_ca_mint_velocity_watch` read `chips_minted` as a **series**. A round that
writes 0 is making a statement they can check: this one minted nothing. A round
that wrote nothing at all would be a hole in that series.

## The gates CI runs and the hook did not

On 2026-09-11 a push went out green from the pre-push hook and CI turned red on
`check-route-targets`: a console plate navigated to `/clubs/${id}/${game}`, a
template the checker cannot resolve, so nobody could prove the button went
anywhere. It was found only because the gates were finally run by hand. That is
a three-minute CI cycle and a red main to learn something a local half-second
knew.

Eighteen gates are added to the hook: every one `ci.yml` runs that the hook did
not, minus three that cannot run there. `check-club-fk-indexes` and
`check-migrations-applied` need `SUPABASE_URL` and a service role key.
`check-phantom-tables` is currently **red** on nine tournament-deal RPCs that
predate this work, and wiring it in would block every push in the repo for a
fault the pusher did not cause; it is written down in the hook rather than wired
in, which is the honest way to leave it.

Measured cost: about nine seconds, on a hook that already runs tsc and a vitest
sweep.

## The suite's timeout cliff

`supabase/migrations` holds 2,917 files and 32MB. A law that wants to know what
is **deployed** has to find the last migration declaring a function, and the
obvious way to write that scans the corpus again for every name: a law asking
about four functions read 128MB. Roughly seventy-five migration-scanning laws
went over vitest's 5 second budget whenever the machine was busy. Every one a
**timeout**, not an assertion failure, and every one green when run alone, which
is the shape that makes a red suite easy to wave away.

`tests/helpers/migrations.ts` reads each file at most once and resolves a
function to the last migration that **declares** it, which is how Postgres sees
it and what stops a law going stale when a later migration rewrites the
function. All six Diamond Games laws now come here instead of carrying six
copies, and they run in 4 to 38 milliseconds. 331 test files still read that
directory their own way; that is the remaining work, and this is where they
should come.

## A ratchet caught one of mine

`report-source-grep-tests` counts test files that pin a `src/utils` module by
**text** rather than importing it, because a pure importable module greppped as
a string "cannot catch a line that is present and wrong". The baseline is five.
Phase 5's law made it six: it read `src/utils/autoRun.ts` and asserted the words
"outcome" and "payout" were absent from it, which could not even tell the code
from the doc comment.

The claim is made by **exercising** the runner now. It is handed a run and the
page's own busy, blocker and ready, and asked for a verdict; the assertion is
that a verdict only ever carries `kind`, `delayMs` and `why`, so there is no
outcome in it to decide. That is a better test than the one the ratchet
rejected, which is what a good ratchet does.
