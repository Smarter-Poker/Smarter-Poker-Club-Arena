# Keep variant fee qualification independent of the clock

The isolated member-record harness seeds cash hands relative to current_date, while the later variant-fee receipt fixture asserts fixed October 26–29 UTC bounds. After UTC midnight on October 31, cash rake moved outside that range and the unchanged PLO4 assertion failed.

Before taking the variant-fee baseline, pin only the six identified cash hands from the existing money fixture to October 29 at 03:00 UTC. The real maintained source triggers update their derived facts; an exact six-row assertion refuses fixture drift. Every existing fee, variant/date isolation, counting-floor, authorization and unchanged-field assertion remains unchanged. No production function or migration changes.

Validation uses the existing isolated PostgreSQL 17 harness in UTC: the original fixture reproduces Variant/date isolation failed; the corrected fixture passes the unchanged variant assertions and migration replay refusal (native harness prefix exit 0). Earlier qualification remains separate from this fixture correction.
