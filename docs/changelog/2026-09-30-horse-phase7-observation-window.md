# Phase 7 original opponent observation windows

## Defect and bounded repair

Phase 7 reads real opponent statistics, but HorseMind previously discarded the original action times while accumulating those statistics. Its receipt therefore reported `not_recorded`. A read-only retained production sample from engine `bc30e60ce1722e3280cc0268d2917a0bb894bb59`, selected by completed-hand capture time from September 30, 2026 23:16:19 through 23:21:19 UTC, reconciled 633 Phase 7 intended decisions in 375 completed hands. All 633 had the original read-frame digest and all 633 lacked an original observation window. That bounded sample does not establish full fleet coverage or model calibration.

This follow-up retains a versioned original contribution-time envelope in the existing HorseMind aggregate. It follows the same counter through the existing persistence RPCs and hydration, immutable decision frame, Phase 7 receipt, validation and accepted-execution evidence. It introduces no strategy, scheduled repair or parallel observation database.

The metadata distinguishes complete, partial and unknown timestamp coverage. Complete means every contributing population carried original timestamp metadata; the envelope is conservative, not an exact hand census, a rolling recency interval or a guarantee of accurate clocks. Existing records without dates remain unknown. Mixing known and unknown populations can produce partial coverage, never invented historical coverage. Duplicate observations must not refresh dates. Read, flush and hydration clocks are not observation times.

Selected family/size or pooled lifetime statistics and pooled recency each retain their own source attribution. The aggregate receipt envelope describes the selected statistics. Pooled recency remains explicitly pooled; neither window establishes exact table, cash/tournament or exact-variant isolation. MDF-strength-v1 remains uncalibrated. These dates do not certify GTO quality, profitability, causal learning or authority to promote a policy.

## Compatibility and verification boundary

Historical read-frame versions and historical receipt digest bytes remain readable. Missing metadata cannot inherit a current live window during replay. New window objects are detached and immutable. The additive database migration preserves the existing upsert signatures, permissions and counter merge behavior, and accepts older payloads conservatively.

Focused verification covers capture, duplicates, mixed legacy history, original-time bounds, import/export, persistence mapping and real PostgreSQL upserts, original FAST/DEEP frames, receipt validation and accepted controller execution. The existing connected Phase 7 test is extended rather than replaced with a second benchmark.

Implementation, required checks, protected merge, migration installation/readback and live natural proof are recorded separately in the owning delivery checkpoint. This document is not a completion certificate. Multi-board tournament natural-use proof remains unobserved where no eligible production tournament table exists; no production wagers or configuration changes are made to manufacture it.
