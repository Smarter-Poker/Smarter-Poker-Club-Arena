# Rabbit Hunt: what other rooms actually do, with sources

2026-09-05. Dan: "DO A DEEP DIVE ONLINE AND INSURE WE ARE FOLLOWING THE
STANDARD, FOR HOW OTHER ONLINE POKER ROOMS HANDLE THERE 'RABBIT HUNT' FEATURE,
ANIMATION AND FUNCTIONALITY, AND MAKE SURE WE ARE ON PAR, OR BETTER."

Confidence tags: **OFFICIAL** = the room's own docs or rulebook. **MEDIA** =
poker press. **COMMUNITY** = forum, reddit, affiliate. Every claim below comes
from a page that was fetched or rendered directly. Several of the best sources
are JavaScript-rendered and invisible to plain fetching (GGPoker's Salesforce
help centre, WPT Global's Nuxt FAQ, the PokerBros/PPPoker/X-Poker help centres);
anyone re-running this with fetch-only tooling will wrongly conclude those facts
do not exist.

## The five findings that matter

1. **NOBODY PUBLISHES A COUNTDOWN DURATION.** Not one room, any source tier, in
   English, French or German. The strongest published language is qualitative:
   Winamax's "a few brief moments". **Our 1750ms window is our own design
   decision and cannot be defended as parity - but nothing contradicts it.**
2. **Only one room publishes who sees the cards, and it is GGPoker: everyone at
   the table.** We show them only to the buyer. That is Dan's explicit
   2026-08-25 ruling ("These should ONLY APPEAR TO THE PLAYER WHO CLICKED") and
   it is also the safer choice - live poker bans rabbit hunting specifically
   because it leaks information. **Do not "fix" this toward GGPoker.**
3. **Only one room publishes a hard price: WPT Global, a flat $0.01.** Everyone
   else is "a small price" or "listed on the button".
4. **The club-app segment - our closest competitors - monetises this as a
   per-player entitlement, never as a table setting.** X-Poker gates it behind a
   VIP card bought in day tiers, which is the model Dan is now asking for on the
   squeeze.
5. **Live poker bans it essentially everywhere in writing, and the stated reason
   is information leakage, not speed** (2026 WSOP Tournament Rule 81, WSOP Live
   Action Rule 81, Poker TDA Rule 28, and every card room checked). Online and
   live diverge because an online reveal is per-client and the deck is
   reshuffled, so the leak vector the live rule exists to stop is absent.

## Room by room

| Room                    | Has it                         | Cost                                        | Who sees                             | Interaction                                              |
| ----------------------- | ------------------------------ | ------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| GGPoker / Natural8      | YES                            | none published                              | **EVERYONE at the table** (OFFICIAL) | button, plus a **dedicated hotkey**                      |
| WPT Global              | YES                            | **flat $0.01** (OFFICIAL)                   | not published                        | click a **rabbit-backed board card**; no button          |
| ClubWPT Gold            | YES                            | chips, price on the button                  | not published                        | button, **and the hand replayer afterwards**             |
| Winamax ("Reveal")      | YES                            | free                                        | not published                        | cards land **face down on the board, you click to flip** |
| PokerStars              | YES (beta 2024, cash Oct 2024) | not published                               | not published                        | not published                                            |
| partypoker              | YES                            | Diamonds (earned by play)                   | not published                        | click **your own hole cards**                            |
| 888poker                | **UNCONFIRMED**                | -                                           | -                                    | -                                                        |
| Americas Cardroom / WPN | **NO EVIDENCE**                | -                                           | -                                    | -                                                        |
| PokerBros               | YES, "**Rabbit Cams**"         | per-player consumable sent by club managers | -                                    | -                                                        |
| ClubGG                  | YES                            | subscription tier benefit                   | -                                    | -                                                        |
| PPPoker                 | YES                            | Diamonds                                    | -                                    | -                                                        |
| X-Poker                 | YES, "Rabbit"                  | **VIP card, 3/7/30/90/365-day tiers**       | -                                    | -                                                        |
| EvenBet (B2B vendor)    | YES                            | -                                           | -                                    | **a dedicated inter-hand break**, per-table enable       |

### Sources for the load-bearing claims

- GGPoker, who sees it: "Rabbit Hunting allows players to see the remaining
  community cards that would have been dealt after a hand has concluded early.
  **These cards are shown to everyone at the table.**" -
  `help.ggpoker.ca/article/Table-Features-and-Settings---Frequently-Asked-Questions` (OFFICIAL, JS-rendered)
- GGPoker, the hotkey: "**Rabbit Hunt: Reveals remaining cards when the feature
  is offered**", listed among mappable game functions, on a page that states
  "Hotkeys are primarily designed to assist players who manage multiple tables
  simultaneously" - `help.ggpoker.ca/article/Hotkeys---Frequently-Asked-Questions` (OFFICIAL)
- WPT Global, the price and the interaction: "you can opt to pay a $0.01 fee to
  find out what the next card would have been" and "when a hand ends, select the
  face-down card with a rabbit silhouette on the back to turn it over" -
  `wptglobal.com/faq` (OFFICIAL, recovered from the Nuxt payload)
- ClubWPT Gold, the replayer path: "The amount of Chips it will cost is listed
  on the Rabbit Hunt button" and "**This feature can also be used later in the
  hand replayer**" - `support.clubwptgold.com/portal/en/kb/articles/rabbit-hunt` (OFFICIAL)
- Winamax, the only room publishing card counts by street and the window's end:
  "If a hand stops before the flop, Reveal allows you to reveal all 3 cards on
  the flop... **Important: you only have a few brief moments to use the Reveal
  feature before the next hand is dealt.**" -
  `winamax.es/en/user-guide_user-guide_reveal` (OFFICIAL)
- PokerStars, the window was lengthened and the scope narrowed (summer 2025):
  players "now have more time" to activate it and "the function is now available
  for every hand that reaches the flop" (so preflop folds are excluded) -
  `hochgepokert.com/2025/08/01/...` reporting PokerStars.de release notes (MEDIA)
- EvenBet, the only vendor documenting a dedicated break: "The players can use
  this feature **during a special break that occurs after a game that meets the
  rabbit hunting criteria is finished**" and "The operator has an option to
  enable the feature of rabbit hunting in both tournaments and cash games" -
  `evenbetgaming.com/knowledge-base/rabbit-hunting/` (OFFICIAL vendor docs).
  Note their break is CONDITIONAL, which leaks that cards remain. Ours is
  unconditional for exactly that reason.
- X-Poker's VIP-card model - `thepokeroffer.com/x-poker-review-2026/` (MEDIA)
- Live bans - 2026 WSOP Tournament Rules Rule 81, 2026 WSOP Live Action Rules
  Rule 81, Poker TDA 2024 Rule 28 (all OFFICIAL, all fetched and grepped)

## Where we already lead

- **A user-facing hide/disable toggle exists at NO major room** except one
  unverified MEDIA claim about iPoker. `rabbit_hunt_button` shipped 2026-09-05.
- **An unconditional inter-hand rest.** Only EvenBet documents anything similar
  and theirs is conditional. `RABBIT_HUNT_WINDOW_MS = 1750` is unconditional
  precisely so the pause never announces that the deck still had cards.
- **Cards to the buyer only**, where the one room that publishes its behaviour
  shows them to everybody.

## Where we are behind, and what it would take

1. **No hotkey.** GGPoker's answer to multi-tablers missing the window, and it is
   cheaper than lengthening the window further. Small: a key binding that fires
   the same handler the button does, disabled when the button is.
2. **No rabbit hunt from the hand replayer.** ClubWPT Gold's genuine
   differentiator: missing the window is not final. We are closer than it looks -
   `HandReplay` exists and the server already keeps the offer purchasable for 90
   seconds (`RABBIT_HUNT_OFFER_TTL_MS`), so the work is wiring the replayer to
   `POST /rabbit-hunt` and deciding whether the TTL should lengthen for this
   path.

## What could NOT be found

- Any published timer, at any room. Any animation timing, anywhere.
- Any complaint that a rabbit-hunt window is too short, despite targeted
  searching across 2+2, CardsChat, r/poker and operator issue trackers. Dan's
  report is ahead of the public record. The documented friction runs the other
  way, toward fewer clicks and toward rationing.
- Whether 888poker has the feature at all. One passing MEDIA clause, contradicted
  by silence across every 888 official page. Two search-engine "quotes"
  asserting 888 specifics were chased to the pages they were attributed to and
  **the strings do not appear there** - they were search-summary confabulations.
  Only opening the client will settle it. Do not put 888 in a comparison table.
- Any GGPoker fee statement, either direction.
- Any regulator position anywhere. New Jersey's N.J.A.C. Chapter 69O was fetched
  and grepped: zero occurrences of "rabbit".
