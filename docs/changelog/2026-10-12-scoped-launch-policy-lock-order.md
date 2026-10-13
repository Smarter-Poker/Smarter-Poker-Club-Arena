# Scoped launch policy installation lock order

The launch migration was refused during live installation. Production deadlock
logs showed policy creation waiting on `auth.users` while accepted-hand commits
waited on the chip ledger already locked by the installer. The older Supabase
policy checker resolves its entire configured allowlist with exclusive locks,
including unrelated authentication and storage tables. The provider corrected
that behavior in [supautils #228](https://github.com/supabase/supautils/commit/42cc7f0c4b2655ee3f70a834e253e6a79c66f1d6).

The unapplied migration now creates its required invoice policies before taking
the closing-ledger DDL locks. Existing financial function bodies, permissions,
constraints and trigger definitions remain intact. The closing-leg function is
still defined before its grants. The four-second lock limit, atomic history,
original settlement lane and migration-window guards remain enforced.

The regression privately builds pinned official pre-fix provider source and uses
two real PostgreSQL connections to reproduce the old deadlock and verify the
correct order. Required accounting CI runs it alongside the existing reset and
recovery qualification. The financial fixture also now uses the actual actor
foreign key to `auth.users`, with explicit identity assertions.

The corrected 1,903-wallet native reset/undo qualification passed and runtime
function hashes are unchanged. Earlier installation refusals left no recorded
migration or partial reset tables. Protected delivery, actual installation,
live recovery proof, final reset and resumed-play verification remain pending.
