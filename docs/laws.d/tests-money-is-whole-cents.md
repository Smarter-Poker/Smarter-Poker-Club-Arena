# tests/money-is-whole-cents.law.test.ts

The rounding policy (Phase 6, 20260907220528): every stored or paid chip amount is a whole number of cents; one amount split among players is split in integer cents by the one allocator so the parts sum exactly; a rate rounds half away from zero to the cent except the union per-(club, game type) share, which truncates so the remainder stays with the union. Pinned against `fn_money_rounding_policy`, the nine `ck_whole_cents` constraints and the TS allocator mirror.
