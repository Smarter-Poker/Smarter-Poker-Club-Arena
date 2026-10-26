# Original Lightning hand coordinates

Before: Lightning supplies four-part turn fences and five-part early fences
ending in `early`. Common hand binders accept the physical engine's five-part
leased fence. The real host/HandController fixture fails all three new tests:
journal anchors, public hand-learning/plan identities and original-coordinate
retention are unavailable. Current-release telemetry independently records
66,389 invalid-turn bindings in the bounded 256-receipt window ending20:12Z.
These are counters, not unique hands or universal coverage evidence.

Change: capture a private original-coordinate descriptor from the host's
verified lease and allocated hand, keeping the current transport fence. Include
it in full request validation and exclude it from policy sampling. Reuse its
validated coordinate in journal, mind and plan ownership. Retain it through
plan issue/commit so another lease cannot substitute for the original. Legacy
requests keep their exact keys. Unknown lease/provenance remains unavailable.

Early looks remain distinguishable and only an intended fold can use their
delayed acceptance path; match the exact accepted action after the original
public prefix, never invent an ordinal or infer an original lease from a later
one. Original committed-receipt lease retention is separately owned in the
active Lightning delivery; this change does not modify that financial receipt.

The changed hand-identity sources must participate in strategy digests before
any future selection. Preserve all retired accounts and existing qualification
gates. No hidden cards, shared reads, activation toggle or new scheduled work.
Full per-horse independent durable memory remains unfinished.

Verification: three real-host regressions failed before repair. All 438 connected
worker, journal, real-host and qualification-digest tests now pass. Server and
client TypeScript checks pass. Source digests now include both hand-coordinate
modules; retained qualification bytes are unchanged and refused under the new
definitions (P10 v4, P11 v6, P12/P13 v3). Exact hosted and live proof remain pending.
