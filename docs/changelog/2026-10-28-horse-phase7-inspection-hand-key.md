# Phase 7 inspection uses the allocated decision hand identity

The private fleet inspector reconstructed a legacy history key even when the retained read frame used the worker's allocated table/hand context. Valid allocated evidence consequently failed the original-frame comparison. Use the same `horsePlanHandKey` helper and retained context as the producer.

Regression coverage creates the utility receipt through HorseLogic and verifies a nonempty-history allocated frame. Malformed contexts and forged frame hashes remain refused; legacy captures retain their existing behavior. This changes evidence interpretation, not tournament utility selection or admission.

The historical sample's 478 original-evidence mismatches are inspection outcomes. The raw captures are no longer retained, so this repair does not retroactively certify those decisions or attribute every mismatch to this cause. The separate 27 utility refusals remain unresolved at the available evidence granularity.

The observer executes from the serving immutable engine image; a protected source merge alone does not install this correction. Engine publication and an affected retained-frame check are required for live verification.
