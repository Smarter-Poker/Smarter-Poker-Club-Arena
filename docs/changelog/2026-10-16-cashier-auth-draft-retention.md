# Cashier survives same-account authentication events

Opening another Club Arena tab can emit Supabase SIGNED_IN for the same account. ArenaAccessBoundary discarded its verified context during that event, temporarily rendered a skeleton and unmounted Cashier, losing its amount draft. Preserve the mounted page while revalidating that same account. Failed revalidation still closes access.

Actual account transitions and sign-out invalidate outstanding reads immediately. Key the admitted subtree by account generation so even batched A to B to A transitions retire old drafts. No transaction authority or cashout guard is relaxed.

Mounted regressions reproduce same-account draft loss before the fix and cover retained drafts, token refresh, batched identity transitions, late responses and sign-out. This client correction uses existing APIs and requires no engine activation or database migration.

The concurrent protected wallet-routing migration `20261016021637` was installed while the production certificate ran. Its Club Bank wrapper now takes the agreement mutex before entering the retained core. Live full-definition fingerprint `08e0c75b5fb1f51fc8c31a8928271fb6`, owner, definer, search path and ACLs match its reviewed post-image. Update the stale verifier pin and retain a regression tied to that migration; no migration is applied by this correction.
