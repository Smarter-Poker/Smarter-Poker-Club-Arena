# tests/the-multitable-walk-plays-only-where-nothing-is-real.law.test.ts

The multi-table walk plays only where nothing is real (Ruling 23, decided by
Claude on Dan's delegation of 2026-09-30). `e2e-live/multitable-walk.mjs` buys
in and plays. It starts only as a test identity (an address ending in
`.invalid`) at a club flagged as a test club (`E2E_TEST_CLUB`, whose
`clubs.tags` holds `test-club`). Otherwise it prints `REFUSED` and exits 2
before a browser opens. It also checks the account the page is really signed in
as before it touches a seat. It never plays Club JAQK, SHARK CLUB, Deep Stack
Society or Midway Union, and no longer defaults to any of them. Its sweeper
stands up only the same test identity.

The law exercises the guards in `e2e-live/lib/test-only.mjs` with a fake fetch
and temporary state files. It never reaches production. It also holds the walk,
the sweeper and the README to the order that makes the refusals come first.
