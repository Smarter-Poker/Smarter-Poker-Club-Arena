# Default Opening Has Its Own Request Identity

The first production certificate for PR #7732 found that automatic opening reused the club-creation request key. The welcome package had already published its initial leaderboard with that key, so the real publication authority refused opening as a different use of the same retry key. The opening transaction rolled back and the reserved fixture was retired.

Automatic opening now derives a separate, stable UUID from its operation namespace, exact club and creation request. Reloads and retries retain that identity, while welcome publication retains its original key. The native opening regression now exercises the real leaderboard publication function with an existing welcome program: the shared key fails before, the separate key succeeds without another bank debit, and replay remains unchanged.

The invite result also recognizes the loaded club's canonical slug through the existing route matcher. The app rewrites UUID routes to slugs, so the former UUID-only comparison could suppress the result sheet. Owner and embedded-view guards remain required. The production certificate requires distinct creation/opening keys and reports the actual RPC error body without weakening success, balance, invite or cleanup assertions.

No additional database migration or engine replacement is required. PR #7732's reserve-reuse migration is already installed; the client follow-up proceeds through protected checks, merge, publication and production certification.
