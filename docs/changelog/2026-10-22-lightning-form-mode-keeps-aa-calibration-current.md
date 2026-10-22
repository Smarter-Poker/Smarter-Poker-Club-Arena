# Lightning Form Mode Keeps A/A Calibration Current

## The Defect

`fn_lightning_rollout_readiness` takes its A/A calibration from `fn_lightning_shadow_report` over the last 7 days: the pair whose shadow version is the live version plus `-port` (m1 against m1-port), at least 30 scored comparisons, and a mean quality delta within 1 point. The report counts a comparison only when both sides carry `snapshot_binding` equal to the Cluster's current `fn_lightning_matcher_binding`, which the engine learns only from the authoritative snapshot `fn_lightning_match` returns.

A forming worker calls `fn_lightning_match_and_form`, which returns the hands it formed and no snapshot. The shadow runner was fed only those form passes, scored the live side's formed hands against the shadow's full plan on the engine's own pool model, and recorded every window with `snapshot_binding: null`. Production evidence on 2026-10-22: of the pilot comparisons since 2026-10-18, 7,302 form-mode windows carried no binding and counted for nothing (their mean delta was 5.4 points, an artifact of comparing a capped formation with an uncapped plan on an estimated snapshot), while the 70 windows from the operator's shadow-mode calibration window carried the current binding with a mean delta of 0.00. Readiness could only be fed by switching the pilots to shadow mode, which deals no hands.

## The Fix

With the shadow matcher on, a forming worker now also reads `fn_lightning_match` (STABLE, writes nothing) at most once every 5 seconds, one read in flight, after the formation has answered and never awaited by a pass. It hands the live matcher's plan and the authoritative snapshot it planned on to the shadow runner exactly as worker shadow mode does, so form-mode windows are the same plan against plan A/A comparison under the current binding. While those reads answer with a snapshot, form passes are history only (their hands still enter the pool model; neither side is scored on them), because a window may carry only one binding. A read that fails or carries no snapshot leaves form passes scored as before, and a matcher that is not deployed is asked again only after 10 minutes.

A/A remains defined as before: the live version against its `-port` version. Readiness, the report, the window (7 days), the count (30 comparisons) and the bias threshold (1 point) are unchanged. No database change.

## Ships

Engine runtime, at the daily 04:00 America/Chicago engine release. After it, pilots can stay in form mode and keep dealing hands: each closed window records `snapshot_binding` equal to `fn_lightning_matcher_binding(cluster)`, and `fn_lightning_shadow_report` shows the m1 against m1-port pair with `aa_calibration: true`.

## Tests

`server/src/lightning/LightningFormModeAaCalibration.test.ts` drives a real forming worker with the shadow matcher on: closed windows carry the binding on both sides and are scored only on the A/A reads, reads are bounded and read-only, the live formation calls are identical with the reads on or off, nothing is read with the comparison off, and an undeployed matcher is asked once per 10 minutes while form passes are scored as before. The Phase 11 fixture's list of permitted calls now includes the read-only matcher.
