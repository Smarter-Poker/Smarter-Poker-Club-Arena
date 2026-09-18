# Cash provenance fixture retains the original allocation epoch

The cash provenance boundary fixture constructed a prepared hand number without
the allocation epoch now retained by `prepareNextHand`. The real admission guard
correctly rejected its undefined epoch before all seven accounting boundary cases
could reach their intended assertions.

The fixture now carries the actual engine allocation epoch alongside its prepared
number and timestamp. Production allocation, admission, lease and accounting code
and every existing assertion are unchanged.

Validation: the focused `CashFundingProvenanceBoundary.test.ts` run reproduced all
seven failures before the correction and passes all seven afterward. Protected
integration and production verification belong to the containing accounting release.
