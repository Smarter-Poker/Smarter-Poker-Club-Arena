# tests/a-bystander-seated-after-a-finished-hand-does-not-hold-its-settlement.law.test.ts

The abandoned-generation door (fn_f06_abort_abandoned_generation) reads the event's last dealt hand by when it was played (COALESCE(ended_at, created_at)), so a finished hand its successor commits late from a retained submission never turns the level clock back; the migration that installs it (20260926131050) leaves the live successor handoff of #5320 (20260926091630) untouched, and the superseded 20260926091455, which pinned an older handoff and could never apply, stays deleted.
