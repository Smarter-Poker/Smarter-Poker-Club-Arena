# tests/a-rolling-hour-wait-keeps-the-authorized-minute.law.test.ts

A rate-limited recovery waits for the seal's exact rolling-hour eligibility, then rechecks the existing owner minute and all original admission guards.
