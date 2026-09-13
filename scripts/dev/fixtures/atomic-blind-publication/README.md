# Atomic tournament blind publication rehearsal

Run `TMPDIR=/tmp python3 scripts/dev/probe-atomic-tournament-blinds-pg17.py`
from the repository root with PostgreSQL 17 installed. The probe creates a
private local cluster, uses bounded WAL, retains its evidence, and removes
only its own cluster in cleanup. It accepts no production database URL.

The two new migrations, table-birth trigger, scoped settlement-lock helper and
current generation-claim function execute as real SQL. Minimal tournament,
table and lease rows are synthetic. Maintenance is an explicit fixture
boolean. Trusted PostgREST context is set directly; this is not an HTTP
authentication, full production-trigger composition, money settlement or
full dealer certification. The existing production BEFORE INSERT triggers
were separately read; none changes the blind values after inheritance.

The probe checks whole-field publication, unchanged unrelated/closed tables,
replay and a shifted break anchor, stale table births, write exceptions,
suppressed/altered writes, pause and terminal refusal, bad amounts, role and
lease fencing, MVCC visibility, concurrent birth, heartbeat renewal, actual
generation takeover and the maintenance admission barrier. Successful clocks
come from database time after the field writes, not an earlier retry request.
Separate schema installation also reproduces a table writer that must read
the parent before releasing its table lock. Source hashes for the two captured
dependencies are in sources.json.
