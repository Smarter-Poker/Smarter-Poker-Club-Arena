# Lightning has no waiting list, and a seat buy-in follows the player

Dan, 2026-10-24: "THERE SHOULDN'T BE A WAITING LIST WHEN THERE ARE ALWAYS OPEN
SEATS. REMOVE THE ABILITY TO EVEN JOIN A WAITING LIST IN A LIGHTNING GAME,
PLAYER BUYS IN AND GETS DEALT INTO A NEW TABLE ASAP, NO WAITING" and "WOOWOO
JOINED MY TABLE AND WAS DEALT IN, BUT HIS PLAY IS FROZEN ON HIS DEVICE".

- Lobby card, lobby row and game panel never show Full, Join Waitlist, Leave
  Waitlist or the Waiting count for a Lightning game; Join Lightning is always
  offered (disabled only while an operator has closed joins).
- A spectator on a physical table of a Lightning game gets one Join Lightning
  button to the game's entry page instead of the table's waiting list or
  "tap an open seat".
- WooWoo's freeze, read from rows: three pool sessions (11, 4 and 8 hands)
  with zero voluntary actions; every hand ended in a timeout fold. He bought in
  by tapping a seat on the physical anchor table, so the database moved him
  into the pool, but only the Join Lightning page set the entry intent that
  carries a tab into the pool-session room. His tab stayed on the anchor. A
  seat buy-in at a Lightning anchor now sets the same intent. No chips were
  lost (`fn_unaccounted_seat_exits` is empty for him).
- Classic full tables keep their real waiting list.
