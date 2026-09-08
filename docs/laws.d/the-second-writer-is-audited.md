# tests/the-second-writer-is-audited.law.test.ts

Phase 7 of the chip-accounting programme, roadmap 9.6. The database registers
every money door; the World Hub, in another repository, calls them by name over
PostgREST, and nothing had compared the two until 2026-09-07 - two routes were
calling doors closed four days earlier and three calls carried parameter names
no live signature accepts. `fn_ca_second_writer_check` answers for a list of
(file, line, fn, parameter names) with named finding kinds and an `unchecked`
count; the generic doors (`increment_column`, `fn_atomic_increment_field`) carry
allowlists and are registered; `scripts/ci/audit-second-writer.mjs` scans the
World Hub's routes hourly from `schema-manifest-refresh.yml` with the estate's
App token, refuses an empty directory or an unreadable answer, and raises a
named issue on any finding.

Extended by the phase 7 deep dive (2026-09-07): the scan covers the whole World
Hub server side (`pages/api`, `src/lib`, `lib`), not one directory - the legacy
poker engine under `src/lib` was calling two closed doors from outside the
directory the first check watched; the scanner walks balanced braces so nested
object keys never leak into the parameter list; a `second-writer-exempt:`
annotation is reported, never counted as fine; and severity is the database's
word - a finding on a money door (in the register, or a balance writer) is an
error, on any other function a warning, so the check fails on chips and tells
the other lanes what it saw.
