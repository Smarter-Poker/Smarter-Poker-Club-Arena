# Tournament creation preserves clock units

The scheduled creator wrote `lateRegistrationLevels` into both `late_reg_levels`
and `late_reg_mins`. Recurring club and union creators likewise wrote 8/8 and
10/10. The level field controls admission; the minute field also sets the
from-start Free Buy add-on window in `triggerAddOnPeriod`. A ten-minute ladder
with eight registration levels therefore advertised only eight minutes to that
window, rather than eighty minutes of play.

The correction derives the minute projection from the actual authored ladder
at those three creation boundaries. Preserve the indexed level cutoff, skip
structure break markers exactly as the engine does, and use the last playable
duration for overflow levels. Match the engine's minute/second aliases and
precedence. The integer minute column rounds a fractional final minute upward;
the level gate remains the admission authority. Existing pause/thaw credit and
the separately authored canonical Free Buy minute contract stay unchanged.

Scope is future creation only. Existing events, accepted entries, prices,
prizes, bounties, structures, and restart cloning are not rewritten. SNG and
Spin retain zero late registration. No schedule or recovery loop is added.

Validation: all 18 new connected creator checks failed against the original
writers. The final version passed 189 creator/structure/bounty checks and the
server TypeScript compiler. Coverage includes aliases, skipped break markers,
overflow, fractional minute projection, Free Buy fields, and invalid bounds.
Protected publication and future naturally created event readback remain pending.
