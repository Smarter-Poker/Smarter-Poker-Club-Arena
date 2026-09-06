# The 323 open drift incidents, read one at a time

2026-09-06. Dan asked for every open incident to be read individually and fixed
at the root, with no reconciliation. Result: **323 open -> 104**, criticals
**135 -> 44**, and the four defects that manufactured most of them are closed at
source.

## What the 323 actually were

| bucket                   | rows | what it was                                            |
| ------------------------ | ---- | ------------------------------------------------------ |
| collusion scan           | 104  | a review queue on the wrong board                      |
| `fa:` mirrors            | 83   | a one-way mirror that never learned a resolution       |
| date-rotating keys       | 57   | one standing condition re-filed every run              |
| retro volume             | 1    | the dashboard's "worst discrepancy", not a discrepancy |
| genuine money conditions | 78   | read one at a time; see below                          |

**The mirror never learned.** A critical `financial_alert` is copied into
`ca_drift_incidents`, and raising that incident raises a second alert back. One
engine event became one incident and two alerts, and **nothing carried a
resolution between them** - proven inside this session: fifteen
settlement_barrier alerts resolved at 09:28 still had fifteen open mirrors at
10:00. Resolution now propagates both ways.

**The key rotated on a calendar.** `sweep:fn_bbj_promo_bank_check:2026-09-02`
through `-09-06`, five criticals, same 6705.21, one condition. The raiser now
folds a rotated period label into the standing incident - but only when the
amount is identical, because `diamond-unexplained:2026-09-02-18` is an hourly
bucket where each bucket is a real and separate event. 41 of the 48 rotating
rows carried an identical amount; that is the line.

**The collusion scan was never a chip-drift detector.** Its own text says
"review the pair; no automatic action taken", and it put the chips that _flowed_
between two players into `discrepancy_amount`. It writes every finding to
`ca_collusion_signals` immediately beforehand, so the incident was a duplicate
of a record that already exists. Retired in `ca_detector_registry`; no finding
lost. It could not have stopped on its own - horses are players (10.5), nearly
every hand is horse-only, so every busy horse pair looks one-directional. The
answer is the right board, not a horse filter.

**"WORST DISCREPANCY 97,085,751.26" was not a discrepancy** - it is the chip
volume of 4,317 rows deleted by an authorised maintenance. Moved to metadata.

## The bomb pots, and a correction

19 criticals were `bomb_award_ledger_gap`. Of 25,888 bomb-pot hands in seven
days, exactly 18 had **no** rows in `bomb_pot_award_units` - and those 18 were
the 18 gaps. The pot paid, rake and BBJ were taken, and nothing recorded which
board or which player got which share.

My first answer was to reschedule a repair sweep - an applied migration's cron
job had vanished from `cron.job` entirely. Dan rejected that, correctly: _"WE
AREN'T USING ANY CRONS TO MONITOR OR FIX, THATS A BANDAID... NOT CONSTANTLY
RUNNING AROUND RECONCILING."_ Both sweeps are unscheduled again.

The real defect is that the hand row and its breakdown were **two writes with no
transaction between them**, the second deliberately unawaited. They are one
write now: `fn_ca_insert_hand_with_awards`, one round trip, one transaction, so
the hot path still costs exactly one request.

**A second correction, recorded because the log should be accurate rather than
flattering.** I also attached a DEFERRABLE constraint trigger refusing to let a
bomb hand commit without units - while the engine still wrote them separately,
so nothing in production could obey it. Then I saw a 2m41s gap in bomb hands,
concluded I had broken live play, and dropped it. Both readings were wrong: bomb
pots that hour averaged 28.7s apart with a **maximum gap of 489s**, and three
bomb hands committed with no units _while the trigger was live_, so it was not
blocking either. The trigger is written and kept unattached; it goes back in the
same pull request that ships the engine change, once something can satisfy it.

The live loss rate is worse than the board showed: **3 of 125 bomb pots in the
last hour**, against 18 in seven days as reported, because the detector carries
a grace period and an epoch floor.

## Still open: 104

The genuine money conditions, each read: 30 escrow-vs-counter residues (mostly
heads-up SNG fees never drained), 7 rows of one live 2,523.48 account-vs-journal
disagreement that tripped the kill switch, 5 treasury rows that are Deep Stack
Society's unregistered opening balance, 2 diamond-supply events, 4 insurance
offers, 5 R3 log-only tournament credits, and the 0.30 frozen-pool residual.
None is a detector artefact. Each needs its own code-level fix and they are the
next phases.
