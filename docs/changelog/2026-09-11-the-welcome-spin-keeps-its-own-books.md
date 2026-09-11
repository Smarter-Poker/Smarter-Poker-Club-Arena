# The welcome spin keeps its own books

**2026-09-11. Dan: "CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE."**

An audit of `docs/changelog/2026-09-10-the-bank-backs-the-promo-wallet.md`, the
morning after it shipped. Six findings, five of them mine from the day before.

## The one that predicted the rest

The daily free spin, built on 2026-09-09, carried a law that said this:

> free spins live in wheel_free_spins, never wheel_spins, so a spin with no
> intake cannot put the paid wheel's realised return over 100 percent

Dan's ruling moved the welcome spin onto the real wheel, which is right, and it
put a zero-intake spin into the paid wheel's own table. The answer is not to
move it back: it is to keep the two sets of books apart inside one table, which
is what `welcome_chips_paid` and `is_welcome` are for. Three of the four money
findings below are that separation, finished properly.

And the law test that said so **passed the whole time**. It pins an immutable
migration file, so it went on asserting that a free spin may never pay a chip,
lives in `wheel_free_spins` and comes once a day, while production did none of
those. A green law test guarding a retired law is worse than no test: it reads
as proof. It is retired here, visibly, and replaced by
`tests/the-welcome-spin-keeps-its-own-books.law.test.ts`, which guards the law
actually in force.

## 1. A welcome spin did not say it was one

`fn_wheel_spin_result` never carried the `free` flag that the retired
`fn_wheel_free_spin_result` set, so every welcome branch on the page was dead
code. The visible effect: a player who had just taken their welcome spin was
still shown the welcome plate, and tapping what was on screen got them a
refusal toast. It also meant no past welcome spin was labelled in the history.
One field, in one function, fixes the result, the history and the page.

## 2. The operator's realised return was wrong

The realised-return windows counted welcome spins: zero intake, a real payout.
Every welcome spin pushed the reading above the truth, skewed the z-score, and
could fire the drift flag on a wheel behaving perfectly. They are excluded now,
the way fixtures already were, and what they cost is reported on its own line.

## 3. The paid wheel's diamond float paid for the gift

A welcome diamond prize was gated on the paid float and then drained it. So a
club that had been generous to new members could find the paid wheel's diamond
tiers locked, and its house take understated. The welcome spin's diamond prizes
come from the owner and are charged to the welcome budget; the float is not
theirs to spend, or to be judged by.

## 4. Lock rate could exceed one

`constrained_spins` counted a welcome spin while `spins` did not.

## 5. Dead wiring on every page load

The wheel page read two histories and merged them. The second read
`wheel_free_spins`, which nothing has written since the welcome spin moved, so
it was a round trip for an empty array on every load, every time. One history
now; `fn_wheel_history` already returns welcome spins in order.

Also: the door's plate still said "Free Spin Ready" for a spin that comes once
and for all, and `welcome_spin_ready` was added to the entry read and never
read. Both joined up.

## 6. The doors were open to nobody in particular

Reading the ACLs rather than the grant statements: `fn_wheel_spin`,
`fn_plinko_drop`, `fn_crash_start`, `fn_wheel_commit`, `fn_wheel_state`,
`fn_wheel_history`, `fn_wheel_metrics` and `fn_wheel_set_config` were all
executable by PUBLIC, and so by `anon`. Postgres grants EXECUTE to PUBLIC by
default on CREATE FUNCTION and a migration that only ever GRANTs never takes it
back; the autorevoke trigger cleans up anything made after it, which is why the
doors written this week were clean and the ones written before were not.

Nothing was reachable: every one of them refuses a caller with no account on
its own terms. It is worth doing anyway. `check-definer-authorization` exists
precisely to stop a SECURITY DEFINER function a browser can reach without an
account, it blocked this branch for that shape two hours earlier, and it can
only see the migrations in a diff. The shape it was built to catch was sitting
in the ACLs either side of the one it caught.

The fairness verifiers stay open on purpose: `fn_crash_point_cents`,
`fn_crash_multiplier_cents`, `fn_plinko_table_audit`, `fn_wheel_segments_audit`
and `fn_wheel_host` are how a player checks a round they were shown, and a
verifier that needs an account is not a verifier.

`fn_diamond_game_promo_lock`, superseded by `fn_diamond_game_cover_lock` when
the bank came in behind the promo wallet, is retired.

## Verified

The probe was run against production BEFORE the fix and failed on the first
assertion, which is the point of writing it that way:

    PROBE FAIL: the welcome spin result carries no free flag at all

After the fix, on the live doors, rolled back: a welcome spin says free and a
paid spin does not, and the history agrees; a welcome spin paid 50 diamonds
with the paid float deliberately set to zero and left the float and
`diamonds_paid` untouched; seven welcome spins inside the hour and the
operator's window counted none of them; and the welcome spend is reported on
its own line.
