# Keep the pending Rabbit Hunt browser case deterministic

Required CI for #8715 failed in iPhone WebKit while observing the transient
`Still Connecting...` state. The isolated route answered after 1,900 ms while
the real component sets its slow state after 1,500 ms. That left only 400 ms
for browser scheduling and observation, and did not guarantee that the tile
closed before the response arrived.

The existing browser case now holds its isolated response until it observes
the slow cue and the open Hand Detail dialog after closing the tile. Only then
does it release the response and require the same two restored cards, one
request and hand identity. A finally block releases the held route on failure.
No production code, timeout, retry, financial behavior or assertion was weakened.

This is a directly connected required-CI blocker repair for #8715. The hosted
failure log is retained in the task evidence; final local and hosted results
remain in its existing checkpoint rather than being inferred from this note.
