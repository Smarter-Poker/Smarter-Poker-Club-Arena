# Horse Phase 7B: one physical population for multi-board tournament utility

The ordinary Phase 7 caller previously refused every multi-board state: its
legacy equity pass produces marginal board draws, which cannot be combined into
one physical showdown. The existing shared-deck sampler was available only
inside the Phase 13 proposal wrapper. Phase 7 now acquires that population
directly for supported independent double/triple bomb boards, including when
Phase 13 is off. The default Phase 13 shadow consumer reuses the same acquisition.

## Owning implementation

- `multiway/JointSampleAcquisition.ts` owns the existing canonical/domain guards,
  shared-deck sampler, immutable result and decision-state binding. A copied,
  altered or foreign-state bridge cannot grant sample authority. The sampler
  algorithm, one-deck card removal and baseline RNG stream are unchanged.
- `HorseLogic.ts` supplies the same Phase 7 economic owner with original scoped
  observations, exact joint equity moments, ordered responders and whole-chip
  settlement. Protected commitment folds remain protected. Marginal draws never
  enter this new branch, and Phase 8 multi-board continuation remains unsupported.
- `HorseTournamentUtilityEvidence.ts` carries immutable sampler identity, state
  key, board layout, completed/requested work, physical occupancy and the explicit
  uncalibrated public-line range model. Provenance participates in the private
  input digest. Worker admission checks population consistency; existing
  read-frame, witness and journal owners retain the final acceptance binding.
  Old receipts without the optional field keep their original digest bytes.

The existing ceilings remain 16 requested samples through four dealt seats, 8
above four, at least 8 complete samples, 2.5 ms acquisition sampling and a 4 ms
consumer work limit. Phase 7 includes acquisition, validation, utility and final
receipt work in its limit. Phase 13 charges the reused acquisition cost to its
own limit. Expired or invalid work keeps the reference action and a named reason.

## Declared domain and limitations

Source reachability is the real table scheduler -> bomb hand controller ->
canonical worker -> joint acquisition -> ordinary Phase 7 -> actual acceptance.
Existing tournament tables may carry host-authorized bomb settings. Initial,
later-day and expansion tournament creation leaves bombs disabled by default.
At the September 30 read-only inventory, no production table with a tournament ID
had bomb pots enabled. Therefore natural multi-board accepted-use evidence is
unavailable for that observed population; this source change does not enable
bombs or create wagers to manufacture proof. Keep the applicable natural-use
gate open until an independently configured population supplies it.

Shared-prefix RIT runouts are not betting states in this contract: RIT begins
after betting has ended, and the current engine excludes tournaments. Preserve
the independent-layout worker boundary and reject overlapping cards rather than
guessing a shared prefix. Dead-button incomplete tournament context and existing
variant, seat, depth, recovery, economic and uncertainty refusals remain intact.
No response calibration, solver optimality, strength promotion or daily learning
is claimed. Phase 13 remains shadow/off under its existing worker authority.

## Verification and delivery evidence

Maintained regressions cover independent two/three-board odd-chip awards;
real worker and controller acceptance with Phase 13 off and shadow; one sampler
draw; original private-frame/evidence binding; a utility result finishing at its
deadline; immutable/foreign/marginal sample refusal; retained RNG; and strict
worker population admission. Existing independent layout, shared-card refusal,
high/low settlement, side-pot/refund, fixed-limit and launch-downgrade controls
remain the references instead of a duplicate rules implementation.

The task's existing delivery checkpoint records exact source, applicable local
and hosted results, protected PR/merge, release operation, serving identity and
natural proof separately. This changelog is not a publication or completion
certificate. Source development overlapped 7A's provider work in a separate SSD
checkout. A protected containing release may publish both stages, while each
stage retains its own actual-behavior verification and completion status.
