# 2026-09-22: the wheel never spins twice unattended, and an answered error never loops

Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY", and no player may be trapped.
PR #5043 and #5047 made the Diamond Wheel resend an unconfirmed spin by itself,
start won games by themselves and bring the player back to the wheel. A live
test and an adversarial review of main then found six things still open on the
wheel. This change fixes each at its source.

## Shipped

- **Recovery wording only for a real recovery.** Every spin is saved before
  its request leaves, and the page used that saved request as its "recovering"
  flag, so every ordinary spin read "Recovering Spin" and "Recovering Your
  Previous Spin." while its first request was out. The page now tracks whether
  the saved spin predates the attempt on the wire (found in storage when the
  wheel opened, or an earlier send's answer was lost). An ordinary spin in
  flight reads Spinning.
- **The resend waits for a loss, and never double-sends.** The same flag now
  gates the page's resend (`useAutoSettle`). Before, the resend was pending
  while an ordinary spin's first request was still out: it polled every 400 ms,
  could send a fast-answered spin a second time, and could jump the 1 s backoff
  the moment that request failed. That timing is also why the recovery test was
  flaky.
- **A failed spin-amount read retries itself.** The quote for a newly chosen
  amount set a page error that nothing retried, which left a spinner up for
  good. It now joins the next-spin preparation retry. The chosen amount is
  kept, and the status reads "Preparing Your Next Spin".
- **An error the database answered is an answer** (`DiamondWheelService`,
  every spin door: `spinV2`, `dailyBonusSpin`, `welcomeSpin`, `spin`). Each
  door takes its commit's lock and replays a spent commit before it can move
  anything, so an earlier send that committed is answered by that spin's
  receipt, not by an error. An error carrying a SQLSTATE therefore means this
  execution rolled back, and nothing was charged.
  - 40001, 40P01, 55P03, 57014, and PGRST000 to PGRST003 (PostgREST could not
    reach the database): the same saved request is sent again, until one
    commit has met such an answer three times. That third answer is a refusal.
  - Any other SQLSTATE or PGRST code: a refusal at once, reading "The Wheel
    Could Not Take That Spin". The page clears the saved spin and deals the
    next ticket.
  - No code (the network, a gateway page): unchanged. The page keeps sending
    until it hears back.
- **A receipt that will not verify stops after three.** The server answered,
  and the answer failed the service's or the page's receipt check. Money may
  have moved, so the saved spin is kept. After three such answers the page
  stops sending it, releases the exit guard, reads the wheel again and shows
  "Your Last Spin Is Saved For The Next Time The Wheel Opens". The next visit
  sends it again. These failures throw `WheelReceiptUnverified`, so the page
  can tell them apart from a lost answer.
- **No copy tells the player to check anything.** "Check The Spin Controls
  Below To Continue" is replaced by the blocker itself: the status that is
  actually holding the spin.
- **The wheel never spins twice unattended.** The idle countdown's automatic
  spin, a won game that plays itself, and the return to the wheel together made
  a loop with nobody at the screen. The countdown re-armed on the new mount and
  spent about 100 diamonds a lap until the daily cap; this was observed live.
  `src/utils/playerPresence.ts` now records in session storage, with an
  in-memory fallback, that the last wheel spin was automatic. One document
  listener clears that record on any real input (pointerdown, keydown or
  touchstart, capture phase). The idle countdown notes its own spins and does
  not run while the record is set. Pressing Spin, the Auto Spin run the player
  started, and won games starting and playing are all unchanged. The only
  thing withheld is a second unattended idle spin.
- **A spin the browser could not save is not placed.** Only the first send of
  a spin can hit this, and nothing leaves the browser. It now reads "This
  Device Could Not Save The Spin, So It Was Not Placed". Before, it read as a
  receipt being recovered.

## Tests

- `tests/components/DiamondWheelAutoRecovery.test.tsx`: the unknown-spin
  recovery test runs on fake timers from the first render and steps the
  1 s/2 s schedule exactly. It was previously on real timers inside a 4 s
  `waitFor`, under a 5 s test timeout. New tests cover the wording of an
  ordinary spin, a saved spin found at mount, and a failed quote retrying
  itself (once and twice).
- `tests/components/DiamondWheelAnsweredErrors.test.tsx`: runs the real spin
  door against a mocked PostgREST `rpc`. Covers each refusal class, each
  transient class (three sends, then a refusal), a transient answer followed
  by a receipt, no code (kept and resent), unverifiable receipts from the page
  and from the service (three sends, guard released, saved spin kept, wheel
  re-read), and the next visit playing the saved spin.
- `tests/components/DiamondWheelUnattended.test.tsx`: the idle spin fires once
  and the next mount waits. A pointer, key or touch re-arms the countdown, once
  per input. An unattended tab still spins on a press and runs a full Auto
  Spin. Run spins and pressed spins do not count as automatic.
- `tests/unit/playerPresence.test.ts`: the store, each input type, capture
  phase, subscribers, blocked or full storage, and a new page load in the same
  tab, with a single install.
- Run against the unchanged page and service from main, 22 of the new tests
  fail. Two of those failures are the double send described above.

## Deliberately not changed

- A saved spin that `readWheelPending` cannot parse still makes the load throw,
  and the page then retries that load for ever. That fix belongs in
  `src/utils/wheelPendingSpin.ts`, the shared saved-spin format, which is out of
  this change's scope.
- A pressed spin that lands on a chips prize still waits for Continue on the
  reveal (`WheelWinReveal`). That is the reveal's existing behaviour; a won
  game and a run both continue by themselves.
