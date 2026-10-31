# First-Level Late Registration Clock

The live 4 PM Freezeout started with a confirmed actual start and level index zero, while its level timestamp remained empty. Its level-only registration window consequently displayed no countdown. The shared deadline reader now uses the actual start for that first level only. Scheduled starts, missing actual starts and missing later-level clocks never supply a deadline.

The focused schedule regression covers the visible 75:30 countdown and all three missing-clock boundaries. Existing entry-window tests retain the earlier-of-minutes-or-levels deadline rule.
