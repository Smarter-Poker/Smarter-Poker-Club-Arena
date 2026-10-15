# tests/a-calculating-week-advances-on-its-own-tick.law.test.ts

While a closed club-week is part way through its split recompute, a chunked job 272 tick advances those parts (fn_accounting_split_advance_due) and visits no scope, and never starts a part with less than 90 s of its statement left, so the parts it starts always commit instead of being rolled back behind the scheduler scans and the attempt's preparation.
