# server/src/services/aStalledDatabaseIsOneReport.law.test.ts

A horse tournament context refresh that timed out waits 40 seconds, then 80, before the next attempt instead of stacking a new read on a stalled database every 20 seconds, and returns to 20 seconds once a context publishes; refresh failures are reported once a minute with the count the previous minute held, while the last known context stays published and labelled stale exactly as before.
