# Lightning operator recovery

Continuing existing Phase13 operator PR6610 with current main integrated. The original compilation blocker was absent operator-control/readiness RPCs; their merged qualified migration now resolves both without an allowlist.

A timeout retained the UUID but recomposed changed reason/version arguments on retry. The original full decision is now retained and retried unchanged; fields remain locked while its result is unknown. Definitive refusal permits a fresh decision and UUID. Regression reproduced the changed reason before correction and passes after it.

An obsolete operator read could paint after leaving and reopening the same scope (A/B/A). Each read now owns a scope generation as well as its identifier; old completion cannot update the new view or clear its in-flight ownership. Regression reproduced stale repaint before correction. Cluster detail is also keyed by cluster identity, resetting readiness and dialog ownership on route changes.

Existing art, authorization doors, confirmation text, bounded observation refresh and financial invariants are preserved. Lightning enablement remains gated by the documented staged rollout; this source delivery does not certify general availability.
