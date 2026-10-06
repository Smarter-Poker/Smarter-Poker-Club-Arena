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
  `agent/codex-phase1-20261005/fix/production-customization-cert-contracts`,
  protected follow-up PR #6183,
  worktree
  `/Volumes/SmarterWork/agent-work/codex-club-arena-phase1-20261005/codex-phase1-20261005`.
- Recovered baseline: archived commit `d9c3002f0431663a4015223f86c1ac58b9509294`
  plus its six-file uncommitted regression patch. The candidate first
  integrated protected main `cef7530aea7b5ede5166f7b75d1bbda50c3c4cdc`.
  After the final visual correction, protected main advanced through
  `27174382f2ad44aedb775474af05a69175640354` to
  `e187377e21eb0f408d2287e8022821a1f83f58c1`; it is now integrated without a
  conflict or an overlapping Phase 1 path.
- Policy receipt refreshed after the latest resumption at 2026-10-05T20:08:25.178Z:
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
  `e187377e21eb0f408d2287e8022821a1f83f58c1` with the Phase 1 commits,
  preserving the MTT-only Final Table/realtime/face-deck work and every
  concurrent protected-main gameplay, navigation, Diamond, and horse-policy
  change. Protected/prerequisite paths are byte-identical to current main and
  `git diff --check` is clean. Client/server typechecks,
  production builds, 309 focused client tests, 33 focused engine tests, 16
  production browser journeys discovered by Playwright, policy classification,
  source bindings, and script syntax all pass.
- Hosted run `37322052713` proved every completed lane green except the Table
  Studio visual lane. Its ten mobile coordinated-look screenshots were 290 by
  474 instead of the approved 290 by 455 because the newly complete card-back,
  face-deck, and game caption wrapped onto a second line. The corrected caption
  keeps all facts in one accessible sentence, prints a compact one-line visual
  label, and leaves the 9:13 gameplay canvas unchanged.
- Follow-up head `de85adab2dbe89ade196f1d78f223d95c823667d` then reached
  hosted run `37329786178`. Its server, client, TypeScript, production-build,
  WebGL, source-contract, and Table Studio purchase/realtime/accessibility
  assertions passed. The remaining visual failure exposed a harness defect:
  Playwright's `iPhone 13` descriptor silently selected WebKit even though the
  project and workflow contract named Chromium. The project now overrides
  `browserName` after the descriptor spread, and a maintained law pins that
  ordering. The intentional face-deck cards and compact three-part caption
  made the old WebKit images stale; all thirty baselines were regenerated with
  actual Chromium at consistent 296-by-465 mobile and 595-by-918 tablet
  geometry. Independent review of every Standard, Final Table, and Light-mode
  image found no clipping, ellipsis, missing table/avatar/action content, or
  second-table artifact. Final Table remains the real table and seated avatars
  over the premium broadcast arena. The exact settled-source browser run
  passed 13/13, including purchase charge-once/auto-apply, two-tab realtime,
  accessibility/keyboard/zoom/forced-colors, and all thirty screenshots at
  the unchanged two-percent threshold.
- Exact pushed correction `541d6be52ed982bb5f983ac8420c932be5f8ac0e`
  repeated that proof on hosted Linux Chromium in run `37333729197`, job
  `111843933274`: shared CSS beats, the real purchase/realtime/accessibility
  gate, and all thirty Table Studio images passed with no retry or failure
  artifact. Its server shard exposed that the branch still carried an older
  protected-main horse test which did not name the already-supported
  `work_budget` outcome on a loaded host. Protected main `27174382f2` contains
  that exact correction and its connected Phase 12 implementation, so the
  branch integrated it rather than weakening or blindly rerunning the test.
- The same final-diff audit found that one account's unresolved collection RPC
  could block another account and that an old account lifecycle could update a
  new lifecycle's cache or sync status. The collection writer is now isolated
  per owner and lifecycle, failed mutations remain in exact tap order, stale
  hydration/retry/realtime work is rejected, and a monotonic per-owner revision
  floor replaces signature-based echo suppression. Newer realtime truth is
  retained while writes settle and drained afterward; invalid mutation, seed,
  read, and realtime receipts cannot claim success or poison the revision
  floor. The 40-test hook suite covers two accounts, logout, A to B to A
  lifecycle reuse, failure and retry ordering, canonical cache ownership,
  revision zero, malformed receipts, delayed echoes, and the exact final-write
  versus newer-remote-state race.
- Exact corrected-worktree checks passed: five directly affected Vitest files
  with 93 tests, client TypeScript, the four copy/title gates, Prettier, targeted
  ESLint with zero errors (one pre-existing Fast Refresh warning), 805 source
  pins across 17 binding files, canonical policy comparison, and
  `git diff --check`. The earlier local WebKit launch abort supplies no product
  verdict and is superseded by the intentional Chromium correction and clean
  13/13 settled-source Chromium run above. Hosted Linux Chromium remains the
  final cross-platform browser gate for the corrected commit.
- The production-certificate correction and this checkpoint are pushed in
  protected follow-up PR #6183. Remaining proof: complete its checks/merge,
  verify client publication and exact engine release,
  observe the terminal cutover seal, install/read back `20261005111523`, then
  run the fresh authenticated production commerce/realtime/gameplay certificate
  and verify cleanup plus affected live behavior.

## Final Browser-Certificate Correction — 2026-10-05

- Current owner policy was reread at `2026-10-05T23:13:03Z`: version 2.9,
  manifest `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
  The canonical and portable copies match. This correction is owned in
  `/Volumes/SmarterWork/agent-work/menu-cert-final` on branch
  `agent/codex-menu-cert-final-20261005`.
- Authenticated run `37381227013` proved the hamburger 35 of 35 and Leaderboard
  at 393px and 1440px with zero page, request, subresource, or console
  failures. It exposed two harness defects rather than product regressions:
  routed gameplay asked for visible copy instead of the button's accessible
  name, and the nine-surface Table Management phone audit retained a 30-second
  outer budget even though one cold route may take 45 seconds.
- The gameplay locator now uses `Open Table Studio`, the shipped accessible
  name. The phone audit derives its outer budget from all nine route allowances. The
  private appearance certificate also proves both receiving channels have
  acknowledged their owner-scoped joins before the durable profile write, so
  a pre-subscription race cannot masquerade as a lost broadcast.
- No application, database, engine, authorization, checkout, settlement, or
  realtime implementation changed. Local proof is 19 of 19 focused unit
  contracts, client TypeScript, targeted ESLint, Prettier, `git diff --check`,
  and 12 of 12 affected Playwright journeys discovered. Protected merge,
  publication, authenticated execution, and fixture cleanup remain required
  before this correction can close the production certificate.

## Tournament Continuity Recovery — 2026-10-06

- Current owner policy was reread after resumption at
  `2026-10-06T00:55:06.875Z`: version 2.9, manifest
  `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
  Canonical hashes are `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`
  (owner), `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`
  (operating law), `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`
  (hardening), and
  `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`
  (reference index). Repository, publishing, maintenance, storage, migration,
  and checkpoint instructions remain the active contract.
- The fresh production MTT lane exposed a real 46.509-second causal-gameplay
  silence while its authenticated socket remained healthy. The table-move
  scheduler claimed every source boundary together, then serially resolved
  requests; one ambiguous result could therefore park unrelated tables for
  the full two-call-plus-receipt uncertainty envelope.
- The owned correction branch is
  `agent/codex-phase1-20261006/fix/final-continuity` in the existing Phase 1
  SSD worktree. It claims, resolves, and releases one ordered source group at
  a time. An unknown outcome retains only its exact source fence and immutable
  UUID/input, and no later source from the stale plan is claimed. Receipt,
  retry, refusal, whole-break custody, destination wake, and the strict
  45-second production certificate remain unchanged.
- Exact focused local proof passed 84 of 84 server tests across the move
  boundary, no-false-detector, and tournament-fix suites; the server TypeScript
  build, Prettier 3.8.1, canonical policy check, and `git diff --check` also
  passed. Protected merge, exact engine activation, a fresh two-lane
  authenticated production certificate, guarded forward database completion,
  finalizer readback, and post-install live proof remain required.
