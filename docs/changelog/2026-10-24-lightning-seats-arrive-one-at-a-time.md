# Lightning Seats Arrive One At A Time

The authoritative roster stays immediate. Newly arriving Lightning opponents reveal their existing portrait and nameplate art in 80ms steps, capped at 400ms, while cards, chips, timers and actions stay available immediately. The hero and the seat on the clock are never delayed.

A small occupant-identity ledger retains the last nonempty roster across idle/reconnect frames. Repeated snapshots and the same occupants do not restart an arrival. A changed occupant receives a fresh reveal; leaving or becoming active cancels unfinished visual effects. Reduced motion preserves the sequence without scaling. The Web Animations effect uses backwards fill only, so its final hidden state cannot remain on a live seat.

Actual SeatSlot consumer regression fails before and passes after integration, covering batch/individual arrival, repeated frames, idle/reconnect, replacement, active seats, hero cards, cancellation and reduced motion. No new artwork, drawn chrome, synthetic players, presence timestamps, server dealing delay, polling or financial operation is added.
