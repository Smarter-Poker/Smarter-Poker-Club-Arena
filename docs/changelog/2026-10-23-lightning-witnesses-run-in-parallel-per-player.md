# Lightning Witnesses Run In Parallel Per Player

Every lightning-pilot-witness run shared one concurrency group, so all witnesses ran strictly one at a time. A latency workload yields about four Fast Fold samples in a run of roughly ten minutes, so 60 samples per pilot for R19 took most of a day on one stream. The group is now per player: a player's own runs (financial ones included) still never overlap, while different consented witness players (009, Samantha, milehigh) run side by side. Replay runs keep their own group. No witness behavior changes.

Workflow only.
