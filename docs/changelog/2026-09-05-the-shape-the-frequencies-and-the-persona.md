# The shape of the hand, the leaks a 20bb loss cannot see, and a persona the tuner cannot erase

2026-09-05, phase 2 of the horse deep audit. Three of the five items that
were listed as "needs your call or more than a day".

## V46 — the shape of the hand (PLO and short deck)

Audit 5.1: _no solver data exists for any non-hold'em game_, and those games
are 55% of cash seat-hands. What existed was right as far as it went — every
variant's strength is a percentile on the hold'em ladder, and V35 shifts the
bar per variant — and blind to the same thing: **in Omaha the shape of the
four cards decides the hand, and a percentile cannot see shape.**

Three consequences, all visible in the review table:

- **AAA-x reads strong.** The percentile's favourite Omaha hand is close to
  unplayable: the third ace is dead, and it makes one pair with no redraw.
- **A rundown reads mediocre.** JT98 double-suited is one of the best hands in
  the game multiway.
- **3-betting is anchored on nothing.** Published PLO 3-bets around AAxx and
  flats almost everything else; the engine had one 3-bet bar for every shape.

`HorseHandClasses.ts` classifies the dealt cards — `aa_ds`, `aa_dry`,
`broadway_ds`, `rundown`, `kk_plus`, `pair_support`, `dangler`, `trips`,
`trash` for Omaha; `sd_suited_ace`, `sd_big_pair`, `sd_suited_conn`,
`sd_small_pair` for 6+ — and returns bar shifts in the same units V35 uses,
plus two things a bar cannot say: `neverThreeBet` (a rundown FLATS) and
`foldAlways` (the percentile is lying — trips and trash fold). `HorseLogic`
computes it where it already computes the variant shift; `HorsePreflop` adds
it to `vs35` at the one place that is resolved, so every bar that respects the
game now respects the shape.

Flag `v46Charts` (default on, off in `full_vs_v2_legacy`), receipts
`v46_class_read` / `v46_class_never_3bet` / `v46_class_fold`, and three league
matchups (`plo4_v46_classes`, `plo6_v46_classes`, `shortdeck_v46_classes`) so
the claim is measured rather than asserted. **Hold'em is byte-identical** —
the zero read, verified by a test.

This is not a solver export and does not pretend to be. It is the published
hand-class structure of these games applied where the engine had none. When a
real PLO export arrives it replaces these numbers and keeps this shape.

## V49 — the leaks a 20bb loss cannot see

All 24 hand tags need |net| >= 20bb and most need a showdown loss. Invisible
to every one of them: over-folding to 3-bets, never 3-betting, limping,
passive postflop play, surrendering flops — most of what separates a winning
regular from a losing one, and none of it costs 20bb in one pot.

No hand needs to be read. `horse_daily_play` (phase 1) already holds VPIP,
PFR, 3-bet, fold-to-3-bet, saw-flop, WWSF and postflop aggression per horse
per day. `fn_horse_frequency_leaks(p_since)` turns it into nine leaks over a
7-day, 1,000-hand window, on the same bands `HorseSelfTuner.BENCH` tunes the
dials against — so the audit and the tuner cannot disagree about what a leak
is. `fn_audit_frequency_leaks` reports them nightly, and **a leak shared by a
third of the studied fleet is `critical`**: that is a bar in the brain, not a
personality, and tuning dials against it is the fleet trying and losing.
`ca_horse_frequency_card` is the panel view.

Measured on the first hours of data (76 horses past 200 hands): 36 too loose,
21 never 3-betting, fleet mean VPIP 33.6% against a 19-32% band. The
detector reports `frequency_sample_thin` honestly until a horse crosses
1,000 hands in the window, which is tomorrow.

All nine tags are registered in `TAG_CONSUMERS` as SQL-emitted tags, and
`EveryTagHasAConsumer.law.test.ts` gained a rule for them: an SQL tag must be
written by a migration that shipped and must name the function that reads it.

## V48 — a persona the tuner cannot erase

Audit 5.6: _persona is three numbers_. And underneath it a worse problem —
**the nightly tuner writes the same keys an author writes.** `tightness`,
`aggression` and `bluffFreq` are rewritten every night from measured
frequencies, so an authored personality is one night away from the fleet
average; on 2026-09-04 the regression rule halved all three on 221 of 383
horses in one run.

`HorsePersona.ts` is a separate, typed, bounded namespace under
`horse_profile.persona`: `straddleRate`, `gtoAdherence`, `preferredDepthBB`.
Written by an author or by a deterministic default from the horse id, never
by the tuner — `ThePersonaSurvivesTheTuner.law.test.ts` reads the tuner's
source and fails if it ever names a persona key. It resolves through the same
read boundary as the dials (`resolveHorseStyle`), bounded per field, so a bad
row degrades instead of reaching a decision.

**The voluntary straddle is wired.** A horse has never posted one: the V18
layer that reads a straddled pot shipped 2026-08-26 and the fleet opened
straddle tables 2026-08-28, but nothing on the horse side ever enrolled, so
every straddle on the platform came from a human or the host's mandatory
setting. `ServerTableEngineDealing` now enrolls each horse under the gun by
its own rate, deterministic in (horse, hand) so a replayed hand straddles the
same way twice. Receipt `v48_straddle_enrolled`.

Two defects in the persona hash were caught by the law test's distribution
assertions before this reached a table: `horse-a` and `horse-b` got the
identical personality, and a 0.30 straddle rate straddled 66% of hands —
both because the estate's `h * 31 + c` hash barely mixes. Replaced with
FNV-1a plus a murmur3 finalizer, one independently mixed hash per field.

### What is NOT here, and why

- **Seeding from `horse_personality`.** The strategy note proposed it. It is
  wrong: that table's `author_id` is an `integer` and `profiles.id` is a
  `uuid` — they cannot be joined. It belongs to a different system (it has
  catchphrases, heroes and an origin story) and stays registered as legacy.
  The deterministic default gives every horse a persona with no row at all.
- **Show-a-bluff and sit-out-an-orbit.** Both need hooks this branch does not
  have — the show-cards path from the card-presentation work, and session
  memory from #3160. Shipping the persona fields for them now would be
  registering dead data, which is the thing the ledger exists to prevent.
  They go in with those hooks.

## Tests

`HorseV46HandClasses.test.ts` (17), `ThePersonaSurvivesTheTuner.law.test.ts`
(6, registered), the extended `EveryTagHasAConsumer` law (16), and the whole
engine + horse-service + benchmark suite: 3,481 pass. Migration applied;
manifests regenerated.

---

# V47 — the one number the league cannot produce

Audit 5.4 asked for three things in the proof layer. Reading the code first
changed two of them:

**1. Mirrored deals already exist.** The audit listed "duplicate deals so both
configs see the same cards" as work to do. `runMatchup` has done exactly that
since V12.2: `playHand` is called twice with the SAME `handSeed` and the seat
assignment flipped (`evenIsA` / `evenIsB`), and the statistic is the per-pair
DIFFERENCE — the card luck already cancels. The audit entry was wrong and this
corrects it. The 26 unresolved matchups are unresolved because the effects are
genuinely small, not because the variance was left on the table.

**2. An external sparring agent is not buildable here.** There is no
open-source CFR agent in this estate, and fetching one is out of scope for an
engine repository. Recorded as out of scope rather than quietly dropped.

**3. An absolute score IS buildable, from data the platform already has.**
The hold'em push/fold solver charts give, for each (game type, depth,
position, hand), the solver's frequency for each action. So:

    agreement = mean over probed spots of solverFrequency(the action the horse chose)

`HorseSolverAgreement.ts` builds the spot grid (both references, three
depths, four positions, every hand key, plus the BB-defend node), asks the
brain, and scores. Near 1 = it takes the solver's line; near 0 = it folds
what the solver jams. A mixed spot caps at the solver's own mix — taking
either side of a 50/50 is not a mistake, and a scorer that punished it would
be measuring conformity. A "pure miss" is a spot where the solver is 90%+ one
way and the horse went the other.

**It is not exploitability and is not named that.** True exploitability needs
a best-response calculation against the whole strategy. This is agreement
with a reference over the spots that reference covers — hold'em push/fold —
and the row records exactly that in `reference`.

It runs once a night after the matchups (a few hundred synchronous decisions,
inside the same RNG bracket the league uses, in a HorseMind sandbox so it
cannot pollute the live opponent memory), writes `horse_solver_agreement`,
and `fn_audit_solver_agreement` reports it nightly — `critical` when it falls
more than 0.03 from the previous run, which is the one regression the league
structurally cannot see.

`HorseSolverAgreement.test.ts` (9): the spot grid, the state construction for
both node types, the action mapping, no-reference behaviour with an empty
store, determinism, and that the probe leaves the live RNG stream exactly
where it found it.

---

# The verification pass, and what it found

Run against the finished branch, not from memory.

**Two pieces of dead data, found by grepping every new export for a caller
outside its own file and its tests.** Both were mine, both written in this
session, and both are exactly what the ledger exists to prevent:

- `followsSolver` and `persona.gtoAdherence` had no reader. Now wired: the
  GTO consult (`v27_gto_open_jam`) asks whether this horse takes the chart on
  this spot, deterministically in (horse, hand, node), and a horse with
  adherence under 1 sometimes answers with its own read instead. Receipt
  `v48_gto_deviation`; a test drives 60 live decisions through a loaded chart
  and asserts the deviation fires between 1 and 59 times, and never at
  adherence 1.
- `persona.preferredDepthBB` had no reader either, and wiring it honestly
  would have meant a database read inside the seating path for a field no
  horse has authored. **It was deleted rather than shipped**, with the reason
  written where the field used to be, alongside the same note for `tilt`,
  `showBluffRate` and `sitOutAfterLossRate` — their hooks are not in this
  branch and they go in with the hooks.

**One guard needed its register updated.** `check-horses-are-players` counts
`is_horse` exclusions per file. The V48 straddle round adds one
(`if (!seated?.is_horse) continue`), and it is the law's second sanctioned
exemption — the horse's input device. A human enrolls in the voluntary
straddle by clicking the setting; a horse has no browser, so the engine
supplies the click. **Removing the guard would have the engine overwriting
every human's straddle setting every hand**, which is the bug the line
prevents. Registered with that reasoning.

**Everything else, measured:**

| gate                                              | result                                    |
| ------------------------------------------------- | ----------------------------------------- |
| `tsc --noEmit` (server)                           | clean                                     |
| full server suite                                 | **420 files, 6,003 tests, all passing**   |
| `check-migrations-applied`                        | 4 changed migrations, 0 unapplied objects |
| `check-horses-are-players`                        | OK                                        |
| stubs / TODO / `not implemented` in new files     | 0                                         |
| new SQL functions live + daemon-scoped            | 15/15, none browser-reachable             |
| new tables live                                   | 4/4                                       |
| audit steps wired into `fn_run_horse_daily_audit` | 7/7                                       |
| `fn_run_horse_daily_audit(yesterday)` end to end  | 55 findings, no error                     |

**And phase 1 is demonstrably alive in production**, which is the only proof
that counts:

- **the seat clock**: 627 of 749 seated horses have an action timestamp
  inside two hours, newest 23:17 UTC, deepest session 66 hands. Before
  #3193 it was 0 of 686 and every column was NULL — the `seat_clock_dead`
  detector fired on that state this afternoon and is silent now.
- **`horse_daily_play`**: 806 horses compiling frequency rows today, from a
  table that did not exist this morning.
- **`rake_bb`**: 9,699bb attributed today by the settlement allocator, so
  tonight's tuner judges the rake-adjusted result rather than the rake.
