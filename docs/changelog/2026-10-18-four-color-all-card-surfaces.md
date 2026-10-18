# Four-color cards on direct history and replay entry

Every card reader now starts the canonical account-settings synchronization itself. Opening a replay, hand detail, jackpot hand or reveal directly therefore cannot depend on a table/settings panel having mounted first to replace stale local deck settings. Hydration stays guarded once per account; cards still subscribe only to the deck-style snapshot.

The card-path audit covered live seats and community boards, run-it-twice and bomb boards, Pineapple discard, rabbit hunt, insurance, showdown, previous-hand details, the hand archive, public/shared and Lightning replay entry points, tournament winning hands, jackpot hands, premium cards, game rules and Table Studio previews. Those readers use the canonical CardImage renderer; the miniature table-tab cards already use the four-color suit palette. Face finishes do not override suit colors. Static promotional artwork and face-down backs are not dealt-card renderers.

Retained tests render the real HandReplay and HandDetailView for all nine currently dealt variants: NLH, PLO4, PLO5, PLO6, PLO8, FLO8, FLH, Short Deck and Pineapple. They exercise account ON overriding stale local OFF without any settings panel, replay navigation, rundown navigation, OFF/ON changes and two-/three-board histories. The same readers serve cash, tournament, shared and Lightning histories.

The standalone-card regression failed before the repair (two-color diamond despite account ON) and passes afterward. All 52 source four-color card images independently passed a pixel-color check of their rank/suit corner. No engine behavior, hand history, chip balance or database schema changed.
