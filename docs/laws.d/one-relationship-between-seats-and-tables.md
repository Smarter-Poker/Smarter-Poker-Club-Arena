# tests/one-relationship-between-seats-and-tables.law.test.ts

There is exactly one foreign key from `table_seats` to `tables`. Every other
seat-to-table invariant is a trigger with FK semantics (23503, the original
constraint names, FOR KEY SHARE, cascade AFTER the parent write, fired on
values not column lists, sorted after the stamp). A second foreign key between
the two tables is a second PostgREST relationship, and on 2026-09-09 that
turned every hint-less embed between them into PGRST201 and stopped every
tournament launch for three hours.
