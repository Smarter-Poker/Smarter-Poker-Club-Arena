# tests/a-seat-read-names-its-parent.law.test.ts

Every PostgREST read that embeds `tables` from `table_seats` must name the
foreign key it travels (`tables!table_seats_table_id_fkey!inner(...)`). An
unqualified embed is refused with PGRST201 as soon as a second relationship
exists between the two tables, which is how the horse session rotator went
dark for 3h31m on 2026-09-09 with no log line.
