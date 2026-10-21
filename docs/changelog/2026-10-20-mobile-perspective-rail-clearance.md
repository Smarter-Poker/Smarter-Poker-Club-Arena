# Mobile Table Perspective And Rail Clearance

Owner correction on October 20: portrait six- and nine-handed tables were too wide, players and bets covered the board, and Chat and other table tools did not match Lobby. The owner selected a subtle PokerBros-style perspective taper, keeping the near end wider.

Portrait phones now reserve outer player lanes around a 78%-width canvas. The approved table skin uses a shared projective transform: the far edge is 80% of the near edge while height and the near edge remain fixed. Cards, names, balances and controls stay upright. The board width derives from that same projection. Side players remain at the screen edges; top corner players sit outside the tapered cap. Top-player clearance and the bottom hero reserve are declared independently of hand/action state.

Mobile bets use the nearest painted rail, with clearance for the chip stack, amount label, board and hero bust. Dealer placement shares the projection; collection starts from the actual resting position. Moving top players below Mini BBJ no longer moves their bets onto their plates. The mobile hero's old extra 30px chip lift is removed consistently from both rest and collection.

Square utility tools use Lobby's 34px mobile / 40px desktop footprint. The approved black and blue icon rasters have different transparent gutters, so their painted frames are normalized without replacing artwork. Lifetime VIP Rabbit Hunt keeps its accessible entitlement and removes the visible Unlimited badge; ordinary prices and monthly balances remain.

Regression coverage includes the real occupied SeatSlot, CommunityCards, DealerButton, BBJ, Timebank and Rabbit components, their transitive styles, original card/avatar artwork and Inter font, on six/nine-max rings at 320–480px in playing/revealed states. It checks the actual painted felt, board clearance, bet/player clearance and painted utility-frame size. The existing required CSS Beat spec executes this regression. The production mobile spectator proof also rejects player/bet overlap with the board. Projection/collection and lifetime entitlement checks remain in the unit suite.

The portrait geometry baseline intentionally changes: phones narrow to 78%, reserve more room for the upper pods, and return unused hero-strip space. Desktop and tablet canvas baselines do not change. This is client presentation only: no engine replacement, new engine API, database migration or financial operation.
