# Wallet Retry focus and publication blocker

Publish Club Arena run 34295425050 failed its first client test shard at
2026-09-09 00:39 UTC. The existing wallet balance retry test found focus on
the wallet row instead of Retry. The production origin and public path still
served f6f5ae11 at 00:50 UTC; the failed run's newer stamp had not published.

The component sets balancesError in the result handler and clears loading in
finally. React can commit between those microtasks. The focus effect ran
when Retry was not mounted, then did not rerun when loading ended. A keyboard
user pressing Enter could select the wallet instead of retrying its balance.

Focus now depends on both the error and loading state, matching the Retry
control's render condition. A deterministic regression test separates result
delivery from request completion, reproduces the prior misplaced focus, and
then checks that Enter retries successfully without selecting a wallet. The
existing immediate-result test remains unchanged. All 20 component tests
pass; root TypeScript is checked before push. This does not change balances,
payment processing, or table buy-in semantics.

Publication still requires the normal Hetzner publisher to pass all shards
and both public/origin build-info stamps to contain this commit. A green local
test is not publication evidence.
