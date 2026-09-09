# Rabbit Hunt responses stay with the clicked hand

A reveal response could arrive after the next hand started. The page then read
the new hand refs and attached the previous hand's purchased cards to that hand.
Those late cards could also enter the live-board path after a new flop, and a
replayer purchase unnecessarily changed the live felt.

The request now captures its hand and board before awaiting payment. Live ghost
cards are eligible only for that hand. The retained board keeps the purchased
hand's identity and yields to newer community cards as before. Explicit replayer
requests return their cards to the replayer without changing the live felt.

Three behavioral regressions execute the actual page callback and board selector
with a delayed response; all three failed before the change. No engine snapshots
or events are paused, no additional delay is added, and billing remains server
side.

The engine's fixed 1.75-second Rabbit Hunt window is separate from the purchase.
The reveal endpoint also waits for a metadata audit insert after the charge;
that can delay the purchased response but is not awaited by the dealing loop.
The broader settlement and next-hand delays remain under investigation.
