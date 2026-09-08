# RETIRED_UNSAFE_SOLVER_WORKER

The executable worker that used to live here was retired on 2026-09-08. It
targeted the nonexistent `gto_solve_queue` and `gto_solutions` tables, generated
simplified ranges, and required a production `service_role` credential on each
Windows machine. It could not produce a certified policy and must not be
restored or used as a fallback.

The only Phase 4 V31 producer is the fail-closed pipeline in the World Hub
repository at `scripts/horse-solver-v31/`. Its M1, M2, and compactor processes
receive separate HMAC credentials and send artifacts through the signed World
Hub gateway. They never receive direct database credentials. Club Arena reads
only a database-promoted, provenance-complete V31 dataset into memory; a missing
or incomplete corpus leaves the existing policy path unchanged.

See `docs/SOLVER-DATABASE.md` for the live database boundary and the activation
requirements. Historical migration files are intentionally retained as an
immutable record even when the obsolete runtime tooling they once described is
gone.
