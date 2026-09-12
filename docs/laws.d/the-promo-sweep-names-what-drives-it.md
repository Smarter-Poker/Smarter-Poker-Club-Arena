# tests/the-promo-sweep-names-what-drives-it.law.test.ts

The BBJ promo slice leaves `bbj_pools.promo_balance` every five minutes -
24,965.28 chips in seven days - and nothing in this repo calls the function
that moves it: `smarter-poker-workers/src/routes/bbj-detect.ts` step 6 calls
`fn_sweep_bbj_promo_all()` on Open Claw's five-minute dispatch. So that
function's COMMENT now says it is the live driver, names the route, and says
never to delete it or add a second one; the per-club `fn_sweep_bbj_promo(uuid)`
says it is NOT scheduled and that `mint_club_promo` is its only caller. This
law keeps both halves that way round - the first version pinned them inverted,
which left "DO NOT SCHEDULE THIS" sitting on the one function promo depends on
being scheduled. It also keeps the migration asserting against `cron.job` that
neither sweep has acquired a local driver, keeps that assertion from quoting
the sentence it forbids, keeps this repo free of a caller that would make the
comments wrong, keeps the band-aid register row honest about not being a
band-aid, and reads the actual workers route rather than trusting any comment
(skipping, not failing, where that checkout is absent).
