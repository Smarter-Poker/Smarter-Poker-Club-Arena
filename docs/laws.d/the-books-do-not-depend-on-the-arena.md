# tests/the-books-do-not-depend-on-the-arena.law.test.ts

The diamond trial balance, the hourly deploy gate and the economy report all
called fn_ca_arena_diamonds() directly, so tearing the arena out - which happens,
it was rebuilt from scratch on 2026-09-08 - would have taken the platform's
accounting with it, silently. They read fn_ca_diamond_offledger_float() now,
which the accounting side owns: it returns 0 when no arena exists, because that
is the truth, and RAISES when one exists and cannot be read, because a float that
cannot be measured is not a float of zero. The migration touches no arena object,
so a rebuild can delete freely.
