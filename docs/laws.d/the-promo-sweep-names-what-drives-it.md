# tests/the-promo-sweep-names-what-drives-it.law.test.ts

`fn_sweep_bbj_promo` moves the BBJ promo slice out of `bbj_pools.promo_balance`
every five minutes - 24,965.28 chips in the seven days before this law - and
nothing in this repo calls it: the driver is Open Claw dispatching
`/api/cron/bbj-detect`, a route that lives in the workers repo. So the function
now names its driver, its repo and its cadence in its own COMMENT, and this law
keeps it that way. It also keeps `fn_sweep_bbj_promo_all` refusing to be
scheduled - its comment used to instruct the next agent to schedule it, which
would put a second driver onto the same staging slot, looping every pool FOR
UPDATE against the live one - keeps the migration asserting that no `cron.job`
has acquired either sweep, keeps that assertion from quoting the sentence it
forbids, and keeps this repo free of a caller that would make the comments
wrong.
