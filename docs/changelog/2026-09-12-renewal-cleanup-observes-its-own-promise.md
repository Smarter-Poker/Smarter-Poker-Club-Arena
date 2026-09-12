# Renewal cleanup observes its own promise

Handle rejection from the discarded renewal cleanup promise while preserving the original promise returned to callers, timer cleanup, deadlines and abandonment accounting.

Repair the completion regression harness to extract the actual controller listener structurally. Existing final-stack capture and stale-owner teardown assertions are unchanged. Independent source and formatting review passed; all 51 targeted repository tests passed. Full foundation CI and publication remain separate.
