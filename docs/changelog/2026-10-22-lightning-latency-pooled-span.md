# Lightning Latency Qualification Pools An Unbroken Span

R19 asked for 20 samples in each of 3 one-minute windows. A pilot forms 10 to 13 hands a minute, so match_to_hand could never reach 20 in one window at any speed, and the client-only legs (fold_ack, first render, fast fold, Fold & Watch) receive only a few samples a minute from browser actors.

The qualifier keeps the per-window rule first. When no per-window run exists, a leg may pass on its most recent unbroken span that ends at its latest traffic window, in which every window with traffic has p95 at or below the ceiling, holding at least 3 traffic windows and 60 samples in total. If each window has p95 at or below the ceiling, at most 5% of each window's samples exceed it, so at most 5% of the union does: the union's p95 is at or below the ceiling. This is never weaker than the per-window rule. Any slow window, whatever its size, ends the span; a gap ends it; a full-size breach afterwards still fails the leg. The verdict records method pooled_span with the span, sample total and largest window p95.

Tooling only. No engine, client, database or money change.
