# 2026-09-21: one marketplace, and it is the World Hub's

Dan, verbatim: "WHY IS THE MARKET PLACE PAGES INSIDE OF THE CLUB ARENA
(https://smarter.poker/hub/club-arena/marketplace?club=a41434bb-8d0c-400a-8f0d-e8b3d65afed4&tab=diamonds)
DIFFERENT FROM THE MARKETPLACE PAGES INSIDE THE WORLD HUB
(https://smarter.poker/hub/marketplace). CLUB ARENA MARKETPLACE, SHOULD BE THE
EXACT SAME PAGES AS THE MARKETPLACE THAT EXISTS IN THE WORLD HUB."

## Why they were different

They were two storefronts. The World Hub marketplace is one implementation
(`pages/hub/diamond-store.js`) behind one address per view: `/hub/diamond-store`,
`/hub/vip-membership`, `/hub/merch-store`, `/hub/smarter-rewards` and
`/hub/club-shop`, with `/hub/marketplace` 308ing to the first. Club Arena had
its own `MarketplacePage` at `/marketplace` (Store, Diamonds, Membership, My
Items, Manage) that sold the same things through the same World Hub APIs and
was built and styled separately. Every Club Arena entry point (the club
footer's Market tab, the hamburger, the lobby tile, every Buy Diamonds button)
led to that second storefront.

## What changed

`/marketplace` now renders `MarketplaceRoute`, which hands the player to the
World Hub page that shows the same thing (`src/utils/hubMarketplace.ts`):

| Club Arena address                | World Hub page                                   |
| --------------------------------- | ------------------------------------------------ |
| `?tab=diamonds`                   | `/hub/diamond-store`                             |
| `?tab=membership` (`&plan=` kept) | `/hub/vip-membership`                            |
| `?tab=store`                      | `/hub/club-shop?clubId=<uuid>`                   |
| `?tab=my_items`                   | `/hub/club-shop?clubId=<uuid>&view=my-purchases` |
| `?tab=manage`                     | `/hub/club-shop?clubId=<uuid>&view=manage`       |
| no tab, inside a club             | `/hub/club-shop?clubId=<uuid>`                   |
| no tab, no club                   | `/hub/diamond-store`                             |

A `?club=` slug or 6-digit code is resolved to its UUID first
(`resolveClubUUID`), and only where the destination is about a club at all; one
that cannot be resolved is dropped and the Hub Club Shop picks the player's club
on the server, as the old storefront did. `?view=` is the World Hub's own
deep link to the Club Shop's Store / My Purchases / Manage views, added on that
side in the same delivery.

It leaves the way every World Hub destination in this app leaves
(`GlobalHeader.navigateToHub`): with a live table open the page opens in a hub
tab beside the game (`OPEN_HUB_TAB`), because a full navigation would unmount
every felt; if every screen is already taken the container says so and the
route steps back to where the player was, or to the lobby when this route is
where they came in. With no table open it is a full navigation that replaces
the `/marketplace` entry, so Back returns to the page the player came from.

The in-table "Club Marketplace" menu item now opens that table's club shop
through the same map. It used to name `/hub/marketplace`, which 308s to
`/hub/diamond-store` inside the frame, so the hub tab stopped matching its own
address and a second press opened a duplicate tab instead of focusing it.

The auth guard moved from the route onto the storefront: the Hub marketplace
reads signed out, so a shared marketplace link now reaches it instead of
bouncing off Club Arena's login.

## What deliberately still renders the in-app storefront

- **The native app.** Apple 3.1.1 and Play's Payments policy: diamonds and VIP
  sold inside the app go through StoreKit / Play Billing, which only
  `marketplaceShared.startCheckout` speaks. The Hub page would sell them
  through Stripe inside the app.
- **A card checkout returning to be verified** (`?purchase=`, `?session_id=`,
  `?checkout_request_id=`). Every Club Arena card checkout, the in-table
  Diamond top-up included, returns to `/marketplace`; that page verifies the
  Stripe session against this browser's durable purchase intent, retires it,
  and offers the way back to the table. It holds while the storefront tidies
  its own address (a REPLACE) and lets go the moment the player asks for the
  marketplace again (a PUSH or a Back), so one purchase cannot leave the old
  storefront standing for the rest of the visit.
- **A top-up that owes the player a way back** (`?next=<in-app path>`, validated
  by the sign-in redirect's own validator). The wallet sends a player who is
  short of the cheapest Diamond Arena seat to `?tab=diamonds&next=/clubs/diamond-arena`,
  and only this page carries that continuation through the checkout round trip.

## The World Hub half of the same delivery

- Every off-site checkout navigation in the store breaks out to the top window
  (`src/lib/store/leaveForCheckout.mjs`). Inside a hub tab the old
  `window.location.assign(<stripe url>)` navigated the IFRAME, and Stripe
  Checkout does not support being framed (`Permissions-Policy: payment=()`
  also disables Apple Pay and Google Pay in a child frame). Club Arena's
  `HubFrame` intercepts off-site anchors and states that a programmatic
  redirect is the hub page's own to break out of; now it does.
- `/hub/club-shop?view=my-purchases|manage` selects the sub-view, so My Items
  and Manage arrive where the player asked for rather than on Store. A
  non-operator asking for `manage` gets the storefront, never a blank panel.

## Known differences from the old storefront

The Hub Club Shop's Manage view creates, hides and deletes items and shows the
sales report; it does not yet have the old Manage tab's inline editor (price,
stock, sale price, per-player limits, availability window, order) or its
per-purchase ledger. Those tools now need porting into the Hub's Manage view
rather than living in a second storefront.

## Guarded by

`tests/the-arena-marketplace-is-the-hub-marketplace.law.test.tsx`
(`docs/laws.d/the-arena-marketplace-is-the-hub-marketplace.md`): the address
map, the three exceptions and their release, the hub-tab and replacing
hand-offs including the refusal path, and the App.tsx / ChunkPreloader /
TablePage wiring.
