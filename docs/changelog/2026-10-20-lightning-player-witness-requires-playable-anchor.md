# The Player Witness Requires A Playable Anchor

Run 39461271078 opened no rendered hand and sent no action. Its pinned participation was active, but the actual anchor was sitting out with a pending leave and had not been matched since 15:17 UTC. Active participation alone did not prove that the player could receive a hand. The normal matcher correctly excludes that seat; the witness must not misreport its wait as a broken fold control.

Use one shared playable-anchor preflight for player and latency witnesses. Read the actual own pool's anchor, require the same player, positive finite stack, open seat, and explicit false sitting-out and leave-pending flags. Run it before creating a player session and again before device/action observations. Financial cash-out eligibility remains separate; no seat, horse input, pool, funding, activity rule or detector is changed to make a test pass.

Four active-pool/nonplayable-anchor regressions fail against the original witness and pass after the fix, before any magic link or browser session is created. Existing latency qualification reuses the same predicate. Actual accepted Fold & Watch and its next hand remain required evidence; this preflight repair alone does not certify that feature. Public rollout stays off.
