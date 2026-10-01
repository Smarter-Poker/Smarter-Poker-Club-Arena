# Three Decisions Phase 11 Left Open: The Arena Belongs To The System, The Walk Plays Only Test Clubs, No Standby Engine

2026-09-30. Phase 11 left three questions open for Dan. He handed them back:
"these are all for you to decide not me ... FIX AND FINISH ALL OF THESE". Each
one is decided by Claude on that delegation, recorded as Rulings 22 to 24 in
`docs/DIAMOND-RULINGS.md`, and built.

## 1. The Diamond Arena belongs to the system (Ruling 22)

The arena's club row named a real platform account as owner:
`daniel@smarter.poker`, role god, an account people and scripts sign in as.
Every door that trusts a club's owner treated that account as the arena's
owner. Migration `20260930235500_the_arena_belongs_to_the_system` names the
system account (`system@smarter.poker`) instead. Nobody can sign in as that
account: it has no password, no sign-in identity and no session, and it has
never signed in. The migration:

- lets the owner-wallet trigger skip a Diamond club, because that trigger had
  refused every change of the arena's owner;
- opens a Diamond hand to platform staff with a live session, where before only
  the owner could open one;
- makes the arena guard refuse any other owner.

It was rehearsed in production before and after (43 probes each, rolled back),
applied once and proved live. The former owner is now refused by every
owner-trusting door at the arena, and all nineteen Diamond staff doors still
admit him as staff. Evidence and the full list of readers of the arena's owner:
`docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system.md`.

## 2. The multi-table walk plays only test clubs, as test identities (Ruling 23)

`e2e-live/multitable-walk.mjs` bought in at the cheapest open table in Club
JAQK as whatever account the operator supplied. It now refuses to start unless
it signs in as a test identity (an address ending in `.invalid`) and targets a
club flagged as a test club (`E2E_TEST_CLUB`, tagged `test-club`). Its sweeper
stands up only the same test identity. `e2e-live/README.md` says how to run it
safely. No production run was made.

## 3. No standby engine for now (Ruling 24)

The engine stays one process, as Dan left it on 2026-08-23. A standby adds a
second server and a dual-leader risk for little gain while the supervisor
restarts the single engine, and the scaling gate law already keeps extra
engines off. Revisit when human traffic makes a 30-second crash takeover worth
a second server. Recorded in
`docs/evidence/diamond-phase-11/engine-ownership-and-scaling.md`.

## Open for Dan

`daniel@smarter.poker` had Commander access only because it owned the arena, and
it no longer does. If that account should still open Club Commander, it needs
its own way in: a venue staff row or a subscription.
