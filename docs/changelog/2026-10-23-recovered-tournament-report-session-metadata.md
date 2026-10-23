# Recovered Tournament Reports Keep Their Actual Finish Terms

Live verification recovered KingFish's Nightly result correctly as 353rd, buy-in 35, one rebuy and one add-on, and retained it through reload. The initial-load exit nevertheless attached the fresh browser's three-second, zero-hand counters. That producer now marks initial finished-result recovery as result-only, using the existing host behavior to omit unavailable session counters. Normal live finish reports retain their measured session. A producer regression fails before the fix; the real host/card regression preserves finishing terms while hiding unknown duration and hands.

The broader local hook exposed a cold lazy-chunk race in the existing first-place card test: Suspense stayed empty past the one-second DOM assertion while the other 3,441 contracts passed. The fixture now loads the actual card module in beforeAll; production lazy loading, the real host/card and every assertion remain unchanged.
