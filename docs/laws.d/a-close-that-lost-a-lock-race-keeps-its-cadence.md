# tests/a-close-that-lost-a-lock-race-keeps-its-cadence.law.test.ts

Job 272 retries a weekly close that failed on a transient lock error (40P01, 40001, 55P03) every 5 minutes for 3 hours, like a time-budget failure, instead of once an hour.
