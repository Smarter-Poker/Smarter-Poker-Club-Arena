# tests/a-browser-cannot-write-a-seat.law.test.ts

The engine owns every write to `table_seats`; it runs as `service_role`. Row
level security already refused every browser write, but on 2026-10-05 `anon`
and `authenticated` still held INSERT, UPDATE, DELETE, REFERENCES, TRIGGER and
MAINTAIN on the table, one mistaken policy away from a logged-out visitor moving
chips between seats. The last browser write (TablePage's time-bank refresh) was
removed in #6164 and published before migration 20261005184400 revoked the
privileges. The same migration closes `club_members` to logged-out visitors and
takes REFERENCES, TRIGGER and MAINTAIN from signed-in players, keeping the
INSERT and UPDATE that joining a club uses, and leaves the column SELECT grants
of 20261005115325 exactly as they were. The law pins the migration and its
assertions, that no later migration grants a browser role a write on
`table_seats`, and that no `src` file writes `table_seats`.
