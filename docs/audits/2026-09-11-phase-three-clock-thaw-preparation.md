# CA09 native thaw candidate — prepared, not executed

The proposed database proof is separate from the bounty agent's actual runtime
clock/restart test. No database query in this task succeeded, and no thaw ran.
This is a reviewable candidate, not current-native acceptance or a ready live
operation. Do not claim Phase 3 or CA09 complete from it.

The last tracked complete thaw implementation found is
`supabase/migrations/20260908032311_reconnect_allowance_survives_maintenance.sql`.
The 2026-09-10 clock audit documents newer wrappers and snapshot/credit helpers,
but their full definitions were not found in the tracked current tree. The
candidate invokes existing native authorities and refuses missing or different
historical body hashes; it never installs the older body over a newer authority.

| Historical identity                                           | MD5 from the 2026-09-10 audit      |
| ------------------------------------------------------------- | ---------------------------------- |
| `fn_thaw_platform(timestamptz,numeric,text)`                  | `f058bfbb8fb26b8412868fc9a2cbf900` |
| `fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)` | `071941c4f82d9f676622dc671fb0db40` |
| `fn_thaw_platform_checkpointed(timestamptz,numeric,text)`     | `8390ea3b5e92685cc29c806c494a680a` |
| `fn_snapshot_maintenance_thaw_targets(timestamptz,numeric)`   | `43455b0ff86f51f524b6190fc6bf7dd2` |
| `fn_credit_maintenance_thaw_targets(timestamptz,numeric)`     | `c12308b00489adce1376ba1c1e4ea9d5` |

Tracked `docs/changelog/2026-09-10-tournaments-resume-with-the-platform.md`
documents the essential interface: the first actual thaw snapshots RUNNING
events with `on_break=false`; a synchronized-break owner stays `on_break=true`
until thaw finishes, then the runtime restores its saved level remainder.
The paired runtime test preserves 30 seconds of a 600-second level by anchoring
the resumed clock to resume-time minus 570 seconds. SQL must not give that owner
another maintenance interval. The candidate checks 42 eligible rows (over the
historical 40-row batch), one synchronized owner, one non-running event and one
null clock. It also checks add-on expiry, rebuy, bomb-pot and sit-out clocks,
unchanged stack/time-bank values, identical replay, and the tracked reconnect
helper assertions. Ledger checkpoint keys alone do not prove nonempty data for
every deadline family.

The setup uses the accepted full-hand probe's known synthetic baseline and
copy-record pattern. Replication role is restored to `origin` before tested
calls; no current financial or freeze guard is disabled during thaw. No thaw
receipt or checkpoint is pre-seeded. One outer transaction ends in `ROLLBACK`.
The coordinator must additionally prove complete business and catalog snapshots
are restored. The fixture/schema, wrapper admission and release interval
interpretation are unverified; failure must not trigger a bypass or broad schema
replay. Do not count these prepared assertions as passed.

Compose from the repository (composition has no database or network access):

```sh
python3 scripts/ci/prepare-phase-three-clock-thaw-native.py \
  --root /Users/smarter.poker/Documents/.agent-trees/Smarter-Poker-Club-Arena/codex-chip-entry-swarm \
  --output /tmp/codex-phase3-ca09-clock-thaw.sql
```

Remaining proof gaps: fresh live/native pins; full current wrapper source;
ownership-aware five-argument admission; nonempty waitlist, cashier, bounty,
cash-stay, rejoin, cluster and persisted reconnect rows; separately committed
installments and interruption/replay races; external rollback fingerprint;
paired runtime adoption and browser evidence. No hand settlement/payment is
claimed by this database clock candidate.

Automatic approval review rejected both the live exact-function metadata query
through the Supabase connector and the local native exact-function metadata
query through the remote desktop connector. Reasons: private schema/database
identity metadata disclosure through external connectors was not specifically
authorized by the general Phase 3 instruction. Neither query executed; neither
was rerouted. The independent Mac tracked-file reads also hit HTTP 504; that
transport failure is separate from approval rejection. The coordinator holds
production activation and any blocked verification for explicit review.

Only local Python syntax and source-composition checks were available. No native
SQL parser or server execution was available. Those checks do not certify SQL
runtime behavior or complete fixture compatibility. The raw SQL template refuses
execution until composed, including its exact tracked reconnect-helper body pin.
