# Horse Funding Receipts And Unknown Outcomes

Before: wallets.ts:27-62 omitted the funding operation key and returned false for both explicit rejection and transport failure. Dealing.ts:3322 and Settlement.ts:2701 treated false as insufficient funds and removed the seat. They also replaced the local stack with the requested amount rather than the stack confirmed by PostgreSQL.

After: both paths name the bust with table, user and hand number. The helper uses one deterministic UUID and identical payload for three bounded inline attempts, accepts only a matching scope/amount/key/stack receipt, and distinguishes funded, declined and unknown. Unknown outcomes preserve the seat and registrations. Successful callers use the confirmed database stack. No new timer, watcher or reconciler was added.

The database authorizes before replay, serializes identical operation keys, binds receipt replay to table/club/user/amount and journal category, rejects invalid precision/nonfinite values, preserves the caller's ledger skip context, and returns the original recorded stack/treasury result. Journal errors still abort the transfer. Existing unkeyed callers remain compatible during the scheduled engine cutover; this is not a claim that every legacy path now supplies a key.

Verification: all 260 isolated PostgreSQL cases passed, including 14 new replay/concurrency/validation cases and the prior journal-failure rollback probes. Twelve new transport/receipt cases, two real-engine idle-caller cases and 20 policy tests passed. The full server suite passed 6,815 cases across 482 files. TypeScript --noEmit passed. Source re-read after editing.

Database application succeeded through Supabase apply_migration. Its authoritative recorded version is 20260908121053. The uncommitted local reservation (20260908120044) was aligned to that recorded version before publication; no existing committed migration or database history was rewritten. Verified live function body hash: 5952ede69da9aeb3b22cefa3925d709f.

Engine publication and scheduled Hetzner adoption are pending. Do not describe the new callers as live until their build is verified. The separate cashout barrier fix merged as PR #3727 (b3c7a40c5398a627713555529b661c6d4386eaf8).

Remaining: combined cash-hand crash durability and dependent continuation, all external leave routes, legacy unkeyed funding cutover, and global cashier/ticket/tournament/diamond/downstream-rake scope remain open. No historical balance adjustment or incident closure was made.

The pre-push authorization check required explicit grants in the replacement migration. Production ACL was verified as owner plus service_role only (anon/authenticated execute both false). The source now restates that same restriction for schema rebuilds. No browser permission was added and no gate was bypassed.
