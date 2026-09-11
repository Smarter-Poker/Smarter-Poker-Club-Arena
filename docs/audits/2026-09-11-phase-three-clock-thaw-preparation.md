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

Current source recovery, 2026-09-11

All nine required function bodies now match production by coordinator equality-only checks. The exact release reader is the tracked 66f0ca0e4ebf27a74dd4b7c211c4fd0f body; its difference from the newest tracked 4b99 body is two whitespace characters, with equal normalized text. The narrow current-source composition and provenance manifest are under scripts/ci/fixtures/phase-three-current-thaw-authority.\*.

Two disposable 300-second native attempts have executed, with zero successful proof rows. Both failed during seat fixture preparation with every guard enabled; all 1199 snapshot entries across the approved 15 catalogs and business relations were equal afterward, and source inputs remained stable. First failure: tournament seat acquisition requires terminal authority. Second failure: the expected acquired baseline seat was absent. No trigger suppression or manufactured financial receipt was used.

Automatic review rejected printing full tracked SQL/builder source and later printing synthetic Spin call snippets through the remote connector. Neither command executed. Those payloads were not retried or routed elsewhere. A materially safer local equality/whitespace comparison succeeded. A supported acquired-seat fixture remains pending; if unavailable, accepted-player sit-out coverage must be explicitly excluded. Current native v3 completion, actual future endpoint, and runtime transport/deployment are not yet certified by these failed attempts.

Final current-source native core result, 2026-09-11

PASS for the stated native core scope. Both 300-second and 1200-second scenarios completed using the actual current five-argument v3 authority. The caller supplied one second; the database sampled its own full elapsed interval and credited its future release endpoint. The proof required 42 active level targets, preserved the independent on_break owner and registration start, credited current add-on and existing participant rebuy windows, left an expired add-on unchanged, rejected wrong ownership/announcement identity, retained the durable owner during partial installments, and recovered the exact release receipt without crediting again. It observed admission remaining frozen after the owner row was cleared, then opening only at the actual database release boundary. Current reconnect-helper suffix, distinct grace, replay, long-freeze and strike-preservation assertions also passed.

Both successful runs forced every original deferred constraint, observed outer ROLLBACK, and restored all 1199 snapshot entries across the approved 15 catalogs and business relations exactly. No fixture guard was disabled. Input hashes were stable during both runs and still matched afterward. Full results, source provenance, actual native receipts and snapshot hashes are recorded in 2026-09-11-phase-three-current-thaw-native.json.

Scope limits remain explicit: no nonempty bomb-pot or accepted-player sit-out/stack/time-bank proof; no proof that all fourteen deadline families had nonempty rows; no separately committed installment or cross-connection admission test; no PostgREST transport, runtime five-argument deployment, or production activation claim. Source composition metadata marked native_executed=false describes preparation only; the final native evidence records the two actual successful runs. Earlier failed fixture attempts remain preserved as failures and are superseded only for the narrower stated scope.

The identifier-only Spin dependency output request was also rejected by automatic review and did not execute. No rejected snippets, source, or identifiers were obtained through another route. The coordinator authorized the narrower guard-enabled fixture: synthetic tournament clocks plus an existing participant's deadline, with no new table or player acquisition. Phase 3 is not declared complete by this database proof.
