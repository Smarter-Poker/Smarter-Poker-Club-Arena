# tests/horse-capture-terminal-gaps-free-their-slots.law.test.ts

Phase 14 capture occupancy (fn_admit_horse_observation_capture, both checks in
fn_discover_horse_observation_requests, fn_horse_learning_work_health) counts
only work that can still run: queued, leased, and a source_budget_exceeded gap
wider than 1 ms. Terminal gaps no longer hold slots, and
fn_prune_horse_observation_captures retires them on the 32-day retention.
Before 20261017040330_horse_capture_terminal_gaps_free_their_slots.sql, 254 terminal source_expired gaps plus 2 queued requests filled the
256-slot cap on 2026-10-17 and every new capture was refused.
