# Tournament creation keeps the selected paid field

The public creator read `tournamentId` or `id` from a delegated function that
returns `tournament_id`. A request to pay 15% or 20% of entrants therefore
silently kept the database default of 10%. Its catch-all also swallowed a
failed contract update after creating the event.

The wrapper now decodes the setting before creation, preserves the existing
10/15/20 choices and 10% fallback, validates the successful receipt and applies
the setting to the returned event in the requested club. Missing receipts,
missing rows and failed or altered writes raise, rolling the delegated create
back in the same transaction. Existing authentication, club authorization,
delegated financial formulas, grants, ownership and search path are preserved.
No existing event's payout contract is rewritten.

The Club Arena engine's scheduled, recurring, union and Free Buy writers
carry the selected depth; repeats retain it. The configuration builder sends
the setting to both manual and scheduled creation. The MTT form offers top
10%, 15% or 20%, defaulting to the established 10%. Final paid places are
rounded upward from actual entries by the database when registration closes.
Spin prizes and satellite seat counts retain their separate contracts.

The form also treated its one-million-player technical capacity as a field
estimate. Executing its old payout call produced 150,000 places, 149,999 zero
shares and 4,688,898 serialized bytes. Creation now sends a bounded provisional
ladder; actual entry counts and the selected depth determine the final ladder.
The provisional winner-only shape is not an advertised final MTT prize table.

## Evidence and limits

- The native PostgreSQL 17 probe reproduces both ignored selections and the
  swallowed write failure against the captured old wrapper. The repaired
  migration passes 31 groups, including malformed/missing/cross-club receipts,
  rollback, access checks, repeat application and source-drift refusal.
- The native fixture has explicit stand-ins for authorization and the
  delegated creator. It tests the real wrapper and transaction behavior;
  it is not a full native financial creation or gameplay certification.
- All service suites plus MTT structure coverage pass 3,251 tests across
  186 files. The focused client/configuration set passes 116 tests, and four
  rendered form tests verify selection, a bounded submission at the real
  capacity, and Spin exclusion. Both TypeScript checks pass.
- Migration `20260913194154_tournament_creator_keeps_selected_payout_depth.sql`
  was applied outside the protected window at 19:42 UTC; the database recorded
  version `20260913194226`. Installed source MD5 is
  `b6335e81d6629f8971d2fa378aebe6b1`. Live readback confirmed unchanged grants,
  owner and search path, plus unauthenticated refusal. The source guard refuses
  any unreviewed prior wrapper instead of replacing it.

Run `TMPDIR=/tmp python3 scripts/dev/probe-tournament-create-payout-depth-pg17.py`
from the repository root. It creates and removes its own private cluster and
accepts no production URL. Engine and frontend publication remain separate
from the applied database function and local evidence.
