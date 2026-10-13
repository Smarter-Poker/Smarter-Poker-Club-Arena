# Publisher partial proof metadata recovery

The post-publication gate now recovers missing named original publisher proof steps from the existing immutable verdict receipt when GitHub returns a nonempty but incomplete steps array. Existing original steps and unrelated metadata remain unchanged. Duplicate, malformed, unfinished or contradictory original proof metadata refuses recovery. Complete valid metadata, including reordered proofs, uses no artifact request.

The receipt remains bound to the original repository, workflow, run, successful owning job, attempt, trigger and immutable artifact. Schema 2 outcomes, conclusions and actual verified revision checks remain required. The original 29-second deadline, GET-only metadata reads, bounded archive handling, inline origin assertions and live verification remain unchanged.

A focused new partial-response case failed against the prior reader because no receipt download occurred; the corrected receipt/hydration checks pass (64 cases). The failing production gate did not retain its exact partial steps payload, so the specific omitted entry is unknown. This correction is not proof of Realtime provider recovery or completed live browser verification.
