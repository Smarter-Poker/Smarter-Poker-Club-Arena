# The Diamonds Sector Is A Three-Card Game (client)

Owner ruling 2026-09-21, R15, with the presentation half of R2 and R13.
Wheel v4 contract sections 2, 4, 5 and 6.

## What the player now meets

Dan, verbatim (R15): "If 'Diamonds' is won it plays a game where 3 cards pop
up: one is 50% of diamonds risked, one is 2x, one is 3x. After the user selects
a card it awards that prize and reveals all 3 prizes behind the cards."

So the Diamonds sector no longer pays at the spin. The spin seals an award and
the player turns one card over:

- **One spin.** The win reveal stays up, titled Diamond Cards, and its one
  plate reads **Pick A Card**. Tapping it opens the three cards on the approved
  console: face down, the tapped one flips to its value, then the other two
  turn over behind it, then "You Won N Diamonds" and a Continue plate. Nothing
  advances on a clock and nothing is picked for the player (R1).
- **Inside a run.** A pick accumulates exactly as a bonus game does. The Won So
  Far tally counts it ("2 Card Picks") and the end-of-run summary lists every
  pick with the same Pick A Card plate, offered before the bonus games because
  a pick is a tap on this page and its diamonds are not paid until it is made.
- **On load.** A non-empty `state.pending_cards` shows a persistent "You Have A
  Diamond Card Pick Waiting" card and blocks the next spin with "Pick Your
  Diamond Card Before Another Spin", the way an unplayed bonus game does.

A Diamonds spin whose award is still pending is never described as paid: the
notice reads "You Won A Diamond Card Pick" and the details readout says the
three cards are waiting.

## The odds panel states the real mix (R13, R2)

The prize panel now prints the mix the player actually faces, computed from the
segments the server sent rather than from a number typed into the client: "A
Bonus Game Or The Diamond Cards 50% Of The Time. Instant Chip Wins 30%.
Throwables, Time Banks And Rabbit Hunts 20%." plus "Never The Same Prize Twice
In A Row." A VIP (`state.vip`) is served a table whose three item sectors are
instant chip wins, so their panel reads 50% chips and says so: "Your VIP Card
Pays Throwables, Time Banks And Rabbit Hunts As Instant Chip Wins Instead."
Shares round DOWN to one decimal with a bare `.0` dropped, so a figure is never
overstated.

## Contract

- `fn_wheel_diamond_cards_pick(p_award_id uuid, p_card smallint)` ->
  `{ok, award_id, picked, cards:[v1,v2,v3], paid_diamonds, balances:{diamonds},
fairness}` or `{ok:false, error:'<Title Case Reason>'}`. Wrapped by
  `DiamondWheelService.pickDiamondCard`, which refuses to send a card outside
  1..3, keeps a refusal in the server's own words, and throws rather than show
  a prize when the answer does not add up (`paid_diamonds` must be the picked
  card's value, the hand must be three cards, the award must be the one asked
  about).
- `fn_wheel_state_v2` gains `pending_cards`, `vip` and `model_version`; a
  server that sends none of them reads as a player with no pick waiting.
- The spin receipt's Diamonds outcome carries
  `cards = {award_id, risk_diamonds, status}`; only a `pending` award opens the
  game. The client never reads the values before the pick, and reads `picked`
  from the reply rather than assuming the card it tapped: the RPC is idempotent
  on the award, so a double tap, a retry or a reload reveals the first pick.

## Proof

- `tests/components/DiamondCardPick.test.tsx` - three face-down cards, one pick
  out of a double tap, all three revealed, the paid figure, a refusal in the
  server's words with a retry, keyboard play, and two minutes of fake clock in
  which nothing picks or closes.
- `tests/components/DiamondWheelCardPicks.test.tsx` - the three wirings on the
  real page (one spin, inside a run, on load), each with two minutes of clock.
- `tests/components/WheelCardPanels.test.tsx` - the waiting-pick card and the
  summary's plate order.
- `tests/components/WheelOddsPanel.test.tsx` - the mix copy, standard and VIP.
- `tests/unit/wheelCardPick.test.ts` - the RPC seam and the run tally.
- `tests/diamond-spins-never-start-themselves.law.test.tsx` gains the Diamonds
  case: the reveal waits for Pick A Card and the cards wait for a tap.
- Rendered headless on the console at 393 and 1280 px,
  `node scripts/dev/diamond-cards-render.mjs <outDir>` (face down, revealed,
  refused).

The server half (the migration, the sealed permutation, the payment) is agent
D1's; every test here runs against a mock of the RPC and of the state.
