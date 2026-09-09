# Agent Transfer Receipt Destination

AgentService.transferToPlayer always requests player_wallet. Its receipt validator also accepted agent_wallet, allowing an outcome for the wrong destination to acknowledge the request and clear its retained operation ID.

The validator now requires player_wallet for agent_send. Self-stake continues to validate its canonical player_wallet_after response. A mismatched send receipt throws before balance events or operation acknowledgement; a later matching response reuses the original key.

The regression reproduced in both the validator and the real service:2 tests failed and53 passed before the correction. Post-fix verification is recorded in the phase progress file. No database writes, migration, runtime reconciler or balance compensation are involved.

Phase4 includes all12 original CA-04 controls. Existing canonical routing and durable intent work are preserved. Neither this correction nor Phase3 publication is a claim of complete phase acceptance.
