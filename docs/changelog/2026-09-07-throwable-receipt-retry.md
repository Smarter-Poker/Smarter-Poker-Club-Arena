# Preserve uncertain throwable receipts and play approved throws

A lost RPC response could charge twice on retry because the compatibility wrapper generated a fresh request UUID. ThrowableService now calls fn_use_throwable_v2 with a retained identity scoped to the user and item. Pending identities survive picker remounts and, when session storage is available, refreshes. A definite server outcome releases the identity; transport failures or malformed responses retain it. Storage failure falls back to the in-memory identity without bypassing the server charge.

useTableAnimations also applied a second cooldown after the selector consumed inventory. Variable response latency could put two legitimate server approvals less than 1500 ms apart on the client and silently discard the second paid throw. That check is removed; the authoritative database cooldown and selector in-flight guard remain.

Validation: 19 tests across service, allowance and mounted hook suites pass. They cover lost responses, receipt reuse, new intent after success, persisted recovery, definite rejection, account/item separation, malformed responses, unavailable storage and both approved throws rendering/broadcasting at the same client time. Scoped strict TypeScript passes. No database migration or price/allowance change is required; the deployed v2 function was verified in the earlier live audit.

Limits: this does not add receipt verification to the client-authored realtime broadcast or complete authenticated multi-client browser acceptance. Those are explicitly pending in the handoff audit.
