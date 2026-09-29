# tests/a-contract-the-database-speaks-must-be-one-the-client-can-read.law.test.ts

On 2026-09-23 four Diamond Spins migrations were applied straight to production

- the estate's documented way of shipping schema - and the session ended
  without merging the client that matched them. `fn_wheel_state_v2` began
  returning `contract_version: 4, model_version: 'wheel-v4'`; the deployed client
  accepts 2 or 3 and `assertWheelAward` throws on anything else, so the wheel was
  dead in production for about nine hours and nobody was told. The same drift
  covers the bonus floor (new rounds are opened against `fn_diamond_bonus_floor`,
  half the stake, while `src/utils/diamondBonusPayout.ts` still declares that it
  mirrors `fn_diamond_bonus_minimum`, a tenth) and the receipt version (the live
  CHECK constraints admit `payout_version >= 4`, the client's unions stop at 3).
  Nothing went red because every gate in this repo compares the repo against the
  repo, or the repo against a snapshot of the schema; none of them compared what
  the DATABASE says against what the CLIENT can hear.
  `check-diamond-contract-parity.mjs` compares five surfaces - the wheel
  contract_version and model_version, the prize-kind vocabulary, the segment
  count and the bonus floor rule - with neither side hand-maintained: the live
  side is `pg_get_functiondef`, `pg_get_constraintdef`, `pg_proc.prosrc` and the
  live segments function executed read-only, and the client side is parsed out of
  the client's own type unions and assertions. It fails closed in both
  directions: a migration cannot merge while the client in its branch cannot read
  what it introduces (`--source`, blocking on every pull request), and a client
  cannot drop a contract without the migration that retires it. The live half
  (`--live`, hourly in Production Integrity Audit) is the only one that can see
  the 2026-09-23 shape, a migration with no pull request behind it, and exits 2
  COULD NOT TELL rather than passing when it cannot ask. This law pins the guard
  to both of its readers, pins the client declarations it parses so a refactor
  cannot quietly blind it, and pins that it never reports agreement it did not
  observe.
