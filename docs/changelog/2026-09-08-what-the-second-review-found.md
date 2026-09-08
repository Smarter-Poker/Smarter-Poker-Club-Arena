# What the second review found: nine defects, four of them mine

2026-09-08. `supabase/migrations/20260908060700_what_the_second_review_found.sql`.

An adversarial read-only review of the six migrations applied earlier that night
found them all correctly applied, byte-identical to their files, with the money
identity exact - and then found nine defects. Eight are fixed here; the ninth is
a process note. None is a repair job: every fix changes the live path.

## D1 (HIGH). A horse could only be paid for what it completed in that transaction

The claim loop selected `completed_at = now()`, so it paid the rows the current
event had just completed and nothing else.

When it went live at 04:38 there were **35,581 completed, unclaimed rows still
inside their seven-day window, worth 2,233,572 diamonds across 1,002 horses** -
every one earned, none reachable, and all due to be extinguished by the expiry.

A human in that position still has a Claim button. That is the whole of CLAUDE.md
10.5: the engine is the horse's input device, and an input device that can only
press the button in the same millisecond the challenge completes is not the same
button.

The loop now claims the horse's whole still-claimable set, oldest first, exactly
as a human working down their list would, and stops at the first refusal -
because the per-user daily cap is the same cap a human meets and the remainder
waits for tomorrow inside the same window.

**This does not reopen ruling 3.** Rows outside the seven-day window are
untouched and still expire: no retroactive mint into idle wallets, for anyone.
What is paid is what a human could still have clicked today.

### The correction, ten minutes after it shipped

This section first said the 2,000 per-user daily cap would meter the drain, so
that "most settles over the window and the rest expires". **That was false when
it was written.** The live counters said so within ten minutes: 653 of 675 paid
accounts went past 2,000, the largest to 2,642, and 1,558,308 diamonds were
issued in the first quarter of an hour.

The cap does not bite because `DR7:user_over_daily_cap` is in `log` mode until
its scheduled flip on 2026-09-14 - it records the breach and refuses nothing -
and that is true for a human exactly as it is for a horse.

The payment is still right. These are earned rewards inside their window, and a
human with the same list and the Claim All button would be paid the same way
today. The supply roughly doubles as the backlog settles, which is a real event
and not a leak, and the velocity alarm makes it visible: it read **548.54**
against a band of 25 and filed once. What the caps should be from here is Dan's
(CLAUDE.md 10.9 - fixing what a past event owes is mine, setting what future ones
owe is his), and the flip that makes them bite is already scheduled.

It is written here rather than quietly edited because it is the same mistake as
D5 below: a derivation that was already false the moment it shipped. Finding it
took one query against live counters, which is the only thing that ever answers
"did it run".

## D2 (MEDIUM, latent). Retention would have truncated streaks

`get_challenge_streak` reads every completed row with no lower bound and walks
back to the first gap, so deleting claimed rows at 60 days would have made any
streak longer than 60 days uncomputable from about November. Zero exposure today.
Completed rows are kept 400 days; the pruning weight moves to D8.

## D3 (MEDIUM). DR13's mode was decorative, and the detector passed it

`fn_ca_diamond_economy_watch` read the rule mode into a variable and returned it
without ever using it, so flipping DR13 would have changed nothing. Worse,
`fn_ca_diamond_unreachable_money`'s third arm was satisfied by a body that merely
MENTIONS the rule name and the function name somewhere - so **the rule that
migration inserted was the first false negative of the detector the same
migration shipped.**

The mode is now used (refuse escalates what it files to critical), and the
detector requires the literal call `fn_ca_diamond_rule_mode('<rule>')`.

## D4 (MEDIUM). The concentration alarm filed on every call, forever

Five identical unresolved warnings in twelve minutes, about a structural fact
nobody can change, into the one table whose retention only removes RESOLVED
rows - so it was unprunable by construction. An alarm that is always on is an
alarm that gets muted (CLAUDE.md 10.84). It files at most once a day per kind
now, and excludes fixture accounts from the concentration figure as every flow
metric in the same family already does.

## D5 (LOW-MEDIUM). The velocity threshold's written derivation was already false

It cited player spending of 370 and a ratio near 50. Both came from a definition
that was replaced 162 seconds later, and neither survived it. Re-derived against
what the shipped definition actually returns - player spend 2,873 against a
faucet of 20,283, a ratio of **7.06** - and the NUMBER was changed to match the
reasoning rather than the reasoning edited to match the number. The band is 25.
It is expected to fire once as the seven-day claim backlog settles, which is a
real event and should be seen.

## D6 (LOW). `sink_30d` held player spend, not the sink

The 05:12 patch reused the variable. Both figures are returned under their own
names now.

## D7. Two changelogs were cited and never written

`2026-09-08-two-landmines-before-the-flip.md` and
`2026-09-08-three-standing-nets.md` were referenced by migration headers that
were already on main. Both are written in this commit. A migration citing a file
nobody wrote is the cheapest possible way to make the record untrustworthy.

## D8 (LOW-MEDIUM). Retention could not reach the class that grows fastest

10,619 rows assigned and never completed, growing about 5,000 a day, which no
expiry and no prune could ever remove. Pruned at 60 days, by which time the day
they belong to is long closed. They are not part of any streak, because a streak
counts completions.

## D9. A process note, not a change

`20260908051206`'s `pg_temp.ca_patch` selected its target by NAME with no
overload guard - the identical trap `20260908043830` was written to document,
reintroduced three hours later in the helper instead of the target. It did not
bite; both targets were unique. The oid-taking version is the one to copy, and
it is what this migration uses.

## Verified

Rolled-back probe, on a real backlog row rather than a fixture: a horse with 35
claimable rows had its oldest (age 6 days 23:59:05 - one minute from expiring)
pay 115 diamonds, 300 to 415, with the register following. Applied 06:03 UTC.
Four minutes later, live: 185 claims, drift `0.00`, zero register follow
failures.
