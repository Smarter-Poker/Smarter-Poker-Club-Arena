# tests/the-client-beacon-cannot-storm.law.test.ts

The client beacon cannot storm and cannot reach the table (Realtime Phase 2): one beacon per reason per minute however often it is called, it returns undefined so nothing can await it, a failing request is swallowed with no retry, and signed out it sends nothing
