# Club Arena Phase 1: Customization Is One Live, Owned System

2026-09-06. Phase 1 closes the gap between a design appearing in a picker and
that design being owned, saved, rendered on the real table, and delivered to
every open device through its authenticated realtime path.

## Product Surface

- Table Studio is a mobile-first, near-full-screen editor with coordinated
  Looks plus separate Tables, Scenes, Buttons, Cards, and Decks tabs. Selectable
  table art no longer lives in the gameplay hamburger settings.
- The catalog exposes ten coordinated Looks, thirteen selectable table skins,
  thirty portrait-first scenes (including ten recognizable Places and ten
  patterned Skins), twelve card backs, ten face decks, and ten dealer/action
  button treatments. White D remains the default.
- The existing 97-avatar library is the only avatar-art source. The Style tab
  adds ten real frame treatments and ten real aura treatments, plus None for
  each; no substitute avatar set is generated.
- Light and Dark modes repaint the editor immediately and persist at account
  scope. The automatic MTT Final Table presentation overlays the event table,
  seats, avatars, cards, and controls on the broadcast arena; it does not paint
  a second table into the background.

## Ownership And Checkout

- Permanent designs are priced from the server catalog, purchased through the
  idempotent feature RPC, journaled once, delivered to the exact entitlement
  ledger, auto-applied, and reconciled after ambiguous network responses.
- Production commerce certification enumerates the paid tiles deployed by the
  UI and requires exact equality with `feature_pricing` before buying every one.
- `avatar_unlocks` is a server-issued entitlement ledger. Browser roles can
  read only their own rows and cannot mint, alter, delete, or truncate grants;
  trusted service-role and security-definer purchase/reward writers remain.
- Avatar, frame, and aura copy consistently names every valid path: active VIP,
  club-shop purchase, or a separately issued reward. Expired monthly VIP flags
  do not grant premium cosmetics; lifetime membership remains durable.

## Live Delivery And Failure Semantics

- Theme, table, background, button, card-back, face-deck, interface-mode,
  collection, avatar, frame, and aura mutations repaint optimistically, persist
  with ordered mutation receipts, and recover without an older response
  overwriting a newer choice.
- Account appearance changes use owner-filtered Postgres Realtime plus named
  authenticated client signals. Seated avatar fanout is table-scoped and
  account-authenticated; polling is only a bounded repair path while the
  Studio is open, never the primary live path.
- Per-game theme buckets reconcile independently, so an event for one game type
  cannot suppress a newer snapshot for another.

## Database Changes

- `20261005111453_phase_one_customization_ownership_face_decks_and_avatar_styl`
- `20261005111523_short_formats_never_reach_final_table`

The first migration is the backward-compatible client and engine prerequisite:
it installs the durable Final Table receipt, public event projection, and
claim/read/ack RPCs without constraining legacy short-format rows. Install it
before releasing the compatible client and engine; it deliberately preserves
the write paths used by the currently served client. The second migration is
post-cutover cleanup only: it retires those legacy customization writes and
applies Final Table cleanup, default/NOT NULL, and the MTT-only constraint only
after the compatible client and engine are proven live.

## Certification Checkpoint

- Scope: recover and finish the Phase 1 customization delivery only. This
  includes its client, named engine-event support, two ordered migrations,
  required workflow wiring, protected merge, publication, and live proof.
- Acceptance: mobile-first layout; table and avatars remain primary; premium
  scenes frame the table; coherent Light/Dark modes; White D default; the
  existing 97-avatar library; immediate durable account-scoped changes;
  idempotent purchases; named realtime propagation; automatic MTT-only Final
  Table presentation; every required check and production proof is terminal.
- Exclusions: no Phase 2 work, no unrelated UI sweep, no new avatar library,
  no retired publisher, no scheduler/watchdog, and no destructive testing on
  active players or games.
- Operation owner: this Codex task, branch
  `agent/codex-phase1-20261005/fix/customization-phase1-certification-closure`,
  worktree
  `/Volumes/SmarterWork/agent-work/codex-club-arena-phase1-20261005/codex-phase1-20261005`.
- Recovered baseline: archived commit `d9c3002f0431663a4015223f86c1ac58b9509294`
  plus its six-file uncommitted regression patch. Current protected base at
  final-candidate integration: `a72cb154fedec2664d5827dd8683d57a07b59c3c`.
- Policy receipt refreshed after resumption at 2026-10-05T14:03:11.751Z:
  version 2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
  Canonical and portable hashes matched. Required repository, publication,
  storage, deployment, hardening, and Club Arena Console references were read.
- Delivery classification: client + engine implementation + database
  migrations + workflow. Client publication has no hourly gate. The Final
  Table transition change is an actual engine dependency, so the compatible
  client and engine must be live before legacy-write retirement and the
  short-format database constraint.
- Previous evidence is retained only as historical input: 1,118 client files
  and 15,488 tests passed; 444 server files and 6,373 tests passed; the earlier
  migration shape replayed twice in disposable PostgreSQL. The final two-step
  migration candidate then passed 102/102 assertions on PostgreSQL 17.11 with
  exact production-shaped eight-character heartbeats, NULL/foreign/stale and
  absent-seal refusal, service-role-only sealing, idempotent retry, replay, and
  post-cutover authority/constraint readback. Qualified migration SHA-256s are
  `79107c24c0da4af4ae6a203e7e8090b7da2d38cdd91b26b85fb8e535a36fa661`
  (`20261005111453`) and
  `01f55a655705900be5c31d9ab88f3efa29d5728107ce73f2802ab5e2aeed0d6f`
  (`20261005111523`). Current-main integration invalidates other
  source-dependent portions, so the exact final candidate receives only the
  affected required checks once.
- The prerequisite/post-cutover order is mechanically enforced: a protected
  schema promise names the new objects, the native PostgreSQL 17 harness is a
  blocking accounting shard input, both authenticated browser lanes publish
  exact certificate outputs, and only a terminal same-client/same-engine job
  may write the append-only cutover seal after both lanes finish. Forward
  supersession is a named non-verdict; NULL or off-lineage identity is refused.
- Prerequisite delivery is durable: PR #6152 exact head
  `43a84fb26c6c8cc7ee580de9b15ee6306200a917` passed core run `37315022620`
  and all ancillary gates, then protected-squash merged as
  `926e19c871d2fdd20177b895e6fa0c18aa8b2e30`. Apply run `37317569025`
  committed and recorded `20261005111453` as `APPLIED`. A separate read-only
  production readback proved one globally unique ledger row, one 90,236-byte
  statement, and exact SHA-256
  `79107c24c0da4af4ae6a203e7e8090b7da2d38cdd91b26b85fb8e535a36fa661`.
  The live function hashes, owners, grants, RLS, realtime publication, ten face
  decks, and ten-frame/ten-aura catalog contract match the qualified post-image.
- The final candidate integrates protected main
  `a72cb154fedec2664d5827dd8683d57a07b59c3c` with Phase 1 head
  `bc48d1165e5d2719d1d57b6e347b6a05b7d8c90a`, preserving both the MTT-only
  Final Table/realtime/face-deck work and the concurrent protected-main gameplay
  fixes. Protected/prerequisite paths are byte-identical to current main and
  `git diff --check` is clean. Client/server typechecks,
  production builds, 309 focused client tests, 33 focused engine tests, 16
  production browser journeys discovered by Playwright, policy classification,
  source bindings, and script syntax all pass.
- Remaining proof: commit this checkpoint, push the exact candidate, complete
  protected PR checks/merge, verify client publication and exact engine release,
  observe the terminal cutover seal, install/read back `20261005111523`, then
  run the fresh authenticated production commerce/realtime/gameplay certificate
  and verify cleanup plus affected live behavior.
