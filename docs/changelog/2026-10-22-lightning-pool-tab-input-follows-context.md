# Lightning Witnesses Select The Pool Tab With The Input Their Context Supports

The shared selected-pool guard always tapped the pool tab. Playwright refuses a tap in a context built without touch, so the player, financial, cycle and latency witnesses (non-touch contexts) stopped at select_existing_pool_tab before any action; the first live run after the guard shipped (milehigh, 2026-10-22 09:10 UTC) stopped there after its Terms step. Only recovery, whose contexts are built with hasTouch, could select.

The guard now takes the input from its caller: recovery passes tap, every other witness uses the ordinary click of the same tab. An unknown input is refused, and a tap in a non-touch context is still refused by the browser rather than passed. Selection verification and the per-gesture selected-pool check are unchanged.

Tooling only. No product, engine, database or money change.
