# tests/a-resolved-refusal-is-not-an-open-refusal.law.test.ts

`fn_ca_hand_commit_refusals` must exclude `financial_alerts` rows that are
already `resolved` from its rolling-window count, so a hand-commit refusal
proven (by its own resolution) to have moved no chips does not keep
re-opening `ca_drift_incidents` for the same conservation-sweep source every
hour until it ages out of the window on its own. The floor of 25, the
rolling window, and the 2026-09-10 correction-watermark fix all stay intact.
