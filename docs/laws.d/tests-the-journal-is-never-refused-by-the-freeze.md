# tests/the-journal-is-never-refused-by-the-freeze.law.test.ts

Chip standard (2026-09-05): a journal row is the record of a write, not a write; the platform freeze guard passes a chip_ledger row written from inside another trigger (the balance write it records was already permitted) and still refuses a direct client insert; a sweep that moves money checks the freeze (fn_bbj_repair_unbanked returns empty while frozen). 104 BBJ bank moves had lost their legs to the guard at :55 and :00
