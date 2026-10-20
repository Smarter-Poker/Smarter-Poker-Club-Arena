# Multiway PLO8 generation 1

The locked Phase 13 matrix on da94e437 (run 39132906218) qualifies with no reasons: +56.13 [53.47, 58.80] bb/100 after rake over 874,368 pairs. Every board-count strength cell is positive.

The prospective 2026-10-19 08:02–08:50 UTC completion record on 41296ff3 clears every street and board-count cells 1 and 2. Board count 3 has no eligible sample and remains refused by the existing board admission gate. Select generation 1 with these exact completion limits and byte-identical shipped evidence. Tournaments remain shadow. Source selection does not establish publication or natural use.

The full pre-push verification exposed a wall-clock dependency in PrestartTicketDiscovery: its start time was ten minutes after the real clock, so maintenance-adjacent minutes could suppress ticket delivery. The test now uses a fixed Date outside that exclusion window and restores the real clock after each case. It failed before the fix and its ten cases pass afterward; production admission is unchanged.
