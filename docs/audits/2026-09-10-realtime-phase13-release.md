# Phase 13 Release Evidence

PR4085 merged at 2026-09-10 02:24:17 UTC as
80d76e0b2fe5ad9593a82cbb0580b50d03a62896. Source head:
6db9ef06368881081f9151409acb02a41d8b8e85.

Eight mounted lobby regressions failed before the repair and pass afterward.
The focused suite passed 71 tests; the normal push gate passed 836 related tests.
CI34428955104 passed all required checks, including the integrated production
build, four client test shards and the browser gate. This closes the local
freshness refusal; no hook was bypassed and no PR was manually opened or merged.

Publisher34429315574 passed build, all four client shards, the actual release
copy/symlink swap and exact origin verification. At 02:28:21.027 UTC both fresh
public and origin build-info named the exact merge. The referenced
ClubHomePage-CdLlP4QP-v6.js was identical on public and origin; SHA256:
6ba405d3a378568555a6e40b0989f5a314093014b8c4f96dd0b494d1c420a567.
The released and tested page blob is 840aca66a55ce38ecc66d5658c8a3dbb9e891afe.
The downloaded code contains the setup epoch/cleanup and guarded queued finally.
Exact stamps and entry/chunk hashes are in the adjacent release JSON.

Controlled-browser baseline: Shark Club rendered 24 rows with no error alerts.
After publication, the browser loaded index--YpkXxdG-v6.js. The subsequent DOM
acceptance check timed out in browser control; the supported recovery retry also
timed out. Post-release UI, natural reconnect and physical iPad/PWA acceptance
remain open. Baseline rendering is not presented as post-release acceptance.

No engine/container/tag/host-checkout mutations or Stage-B DDL were performed.
This continuation did not own the manual b4c427a6 cutover at 01:55:03Z and makes
no claim about that cutover's proof. Its release seal remains with its owner.
