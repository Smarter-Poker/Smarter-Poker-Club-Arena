# Avatar removal qualification waits for bootstrap

The avatar-removal component test now resolves its controlled initial member read inside awaited React `act` before sending a record event. The subscription mock exposes callbacks during render; visible initial content alone did not guarantee the effect-owned refresh handler had settled under publication shard load.

This repairs the publication failure in run 41176796834 without changing runtime behavior, delays, test selection, or assertions. The test still requires a fresh authoritative read, retains the old image while that read is pending, and removes it after the authoritative empty-avatar answer. The isolated test passed before the change; the hosted race was not deterministically reproduced locally.
