# Bounded action acknowledgements and explicit action recovery

The action deadline now covers reading and validating the response body, not just receiving HTTP headers. A stalled or truncated acknowledgement follows the existing bounded recovery with the original idempotency key and decision context. Contextless actions remain single-send. An unknown outcome says it could not be confirmed, including an unanswered attempt followed by throttling; a completed refusal is never replayed.

Exhausted admission throttling reports an action-specific refusal through the existing felt alert and requests one authoritative snapshot. Global infrastructure-popup suppression remains unchanged. A stale hero seat is refreshed before optimistic action painting and never posts the rejected local choice.

Four regression cases failed on protected base baa17e306f5caf0051471bd86b1ea93f033e7ea1, which includes served client a18a2f1781c64e4b517dcc50cc2be17077822d28. Focused tests cover body stalls, truncated acknowledgements, unchanged request keys, contextless refusal to replay, unknown outcomes followed by throttling, complete server refusals, and stale-seat no-send recovery. This source repair does not establish the cause of the reported Mongo or Rooster incidents. Production actions and test bets were not used.

A snapshot wait now distinguishes an observed state from a timeout. If an action outcome and its subsequent state are both unknown, the felt shows the unconfirmed-action message and does not undo optimistic state based only on elapsed time. All five action-panel paths preserve that distinction; the existing snapshot consumer restores the actual current hand when authoritative state arrives. No new polling, engine timeout, automatic fold, or permanent pending latch is added.
