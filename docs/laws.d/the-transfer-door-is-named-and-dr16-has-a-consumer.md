# tests/the-transfer-door-is-named-and-dr16-has-a-consumer.law.test.ts

fn_ca_diamond_unreachable_money() reported two findings from the day it was
written, and both were true on 2026-09-19. send_wallet_diamond_transfer, the
one authenticated player-to-player transfer door that ruling 4 (amended
2026-09-08) allows and migration 20260909200327 restored, was not named in
fn_guard_profile_privileged_columns, so its first wallet UPDATE answered 42501
and rolled back: diamond_wallet_transfers held zero rows, ever, while the
fixture that "verified" Phase 4 carried no profile guard. And
DR16:deposit_inside_settlement_window had no consumer, because the door that
consumed it (fn_arena_deposit) was replaced by the custody model and the daily
arming sweep would have been blocked on 2026-09-22 by "no function consults
this rule".

Migration 20260919223115 names the transfer route in the guard by marker
against the live body, with the route's own md5 pinned so a route that changed
underneath is re-read before the guard admits it, and it wires the rule's mode
into fn_poker_diamond_reserve, the deposit door every buy-in and tournament
entry passes through. That door already refused a purchased lot frozen or
younger than the settlement window under the name insufficient_settled_diamonds;
it now reads the rule so a flip means something. The refusal stands in both
modes because the settled-lot reservation that follows it draws only on settled
lots, so an unsettled lot admitted in log mode would sit in custody with nothing
for a chargeback to find. Armed, the same refusal is raised under the rule's
own code P0416 with a DETAIL naming the rule and the amounts; the leading token
the engine and client match on does not change.

The law pins the marker edit and its reversibility, both md5 pins, the literal
rule name the flip door looks for, the refusal in both branches, every other
refusal the reserve carries, the guard-baseline declarations for both watched
functions, the detector read before commit, and that no grant is widened.
