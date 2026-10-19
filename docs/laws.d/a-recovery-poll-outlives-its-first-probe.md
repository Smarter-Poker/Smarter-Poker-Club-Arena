# tests/a-recovery-poll-outlives-its-first-probe.law.test.ts

An exact desired engine recovery keeps polling /health until its deadline instead of giving up after one probe because its pause raced its own timeout.
