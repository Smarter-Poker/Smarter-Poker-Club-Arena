# tests/the-mini-is-seen-and-discoverable.law.test.ts

The mini bad beat jackpot is visible everywhere the main one is - the felt
plate, the lobby tile, all three popup pages behind a Mini row, the jackpot
page, the toasts, the recipient notification, the hand drilldown and the
operator panel - and every amount it shows is one the payout RPC would
actually pay: each surface gates on the same `backup - parked - amount >=
floor` test, and on the club's own `bbj_pools.mini_enabled` switch. A club
with no union owns that switch (club admins only, default ON for a new club);
a club inside a union follows the union, because the mini pays from the
union's shared reserve. The client's statement of the mini's rule mirrors
`detectMiniBBJHit`, family for family and label for label.
