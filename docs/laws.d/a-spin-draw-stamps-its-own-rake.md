# tests/a-spin-draw-stamps-its-own-rake.law.test.ts

`public.fn_spin_draw_and_settle_atomic` stamps `tournaments.total_rake` from the settlement it just booked (`house_rake`) in the same launch transaction and reads it back with the other drawn columns, patched only from the exact live body with its owner, grants, settings, security and volatility carried over, and back-fills nothing.
