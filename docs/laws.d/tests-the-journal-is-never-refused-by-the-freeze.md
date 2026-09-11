# tests/the-journal-is-never-refused-by-the-freeze.law.test.ts

Chip standard (2026-09-05): a journal row is the record of a write, not a write; the platform freeze guard passes a chip_ledger row written from inside another trigger (the balance write it records was already permitted) and still refuses a direct client insert; a sweep that moves money checks the freeze (fn_bbj_repair_unbanked returns empty while frozen). 104 BBJ bank moves had lost their legs to the guard at :55 and :00
LAW 3 (2026-09-11): the LIVE jackpot payout checks the freeze too, not only the
repair sweep. fn_refuse_while_frozen exempts any service_role caller and the
engine holds the service key, so the database guard never fires for the engine
and processBBJPayout was the only thing that could honour the break. It defers
to the durable claim rather than failing, and the reconciler leaves a frozen row
untouched and counts the deferral as its own outcome.
