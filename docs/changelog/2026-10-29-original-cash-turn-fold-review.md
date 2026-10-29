# Original cash turn-fold review

The existing read-only refill inspector could inspect preflop refusal shapes,
whole-stack calloffs and v4 matched-risk or allocated-plan cases, but could not
report the original pricing facts for a cash turn fold such as hand 51378963.
The separate generic private V56 replay route accepts original ordinals, but its
offline on/off comparison does not expose these original captured pricing facts.

Version 5 (`probe: cash_turn_fold`) extends the same manual, protected-main
inspector. It accepts at most six original source/table/hand/lease/actor/seat and
full public-action ordinal selectors, with the existing 8192-byte input limit.
The installed canonical journal API supplies records inside the existing bounded
child. Original hashes, coordinate, accepted public fold, request anchor, same
producer/turn execution and full hand reconciliation must all agree. Missing,
ambiguous, contradictory or unavailable records remain UNKNOWN. Existing v1-v4
modes, transport bounds, runtime identity checks and cleanup remain intact.

Output contains only closed metadata: own-card count, captured pot geometry,
capped call and uncallable excess, independently labelled derived unraked
reference price, and bounded numeric variant receipt values when retained. Receipt
mode/applied flags avoid presenting a shadow receipt as the executed policy.
Only explicitly allowlisted reason literals may escape; all other reasons remain
unknown. Own made category and original reference equity/reason remain null:
this inspector does not reconstruct cards or rerun a purported original decision.
No raw records, opponent cards, names, request bodies or free-text errors escape.
An observed capture is not proof the fold was strategically correct, a causal
replay certificate, a qualification or permission to activate any policy.

Synthetic regression independently checks the 112 nominal / 36.50 effective call,
75.50 uncallable excess and 375.50 fallback contestable pot, giving
36.50 / 412 = 8.8592233% before deductions. Real maintained hash/anchor/witness/
committed binding/reconciliation components validate the fixture. Source,
coordinate, ordinal, actor, street, action, execution identity and public geometry
substitution controls stay UNKNOWN. The real Python sanitizer rejects private
additions, fabricated derived values and unsupported receipt fields. The new
selector was refused by the unchanged original encoder before implementation.

This is a control-only diagnostic prerequisite. No strategy, authority, roster,
seating, runtime or financial behavior changes. No production capture has run;
hand 51378963's original equity and reason remain unresolved until the owning
agent executes the protected inspector and reads its actual result.

Journal sequence counters are producer-local. A main-publisher accepted-hand
record may have a lower counter than the worker decision/execution pair. The
review compares execution and accepted sequence only for the same producer;
original hand binding and full canonical reconciliation remain mandatory across
producers. A real-component regression reconciles a different-producer accepted
hand at sequence 1 and fails the earlier unconditional sequence comparison.
