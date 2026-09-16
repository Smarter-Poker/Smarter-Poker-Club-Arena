# Club Arena - store listing copy and review notes

Store readiness, phase 6. Everything a listing form asks for, written once
here so App Store Connect and the Play Console say the same thing. Dan's
phase-0 rulings (`docs/APP-STORE-RUNBOOK.md`) are the source for every claim
below; nothing here promises a feature the app does not have.

Copy rules: Title Case on every heading and button the way the app renders
them; no em dashes (CLAUDE.md 10.7); "horses" is an internal word - the
listing says "players" and never "bots".

## Identity

| field                        | value                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------- |
| App name                     | Club Arena                                                                      |
| Subtitle (iOS, 30)           | Private Club Poker Tables                                                       |
| Short description (Play, 80) | Play poker in your private club: cash games, tournaments, spins, on your phone. |
| Bundle / package id          | poker.smarter.clubarena                                                         |
| Category                     | Games > Card (iOS: Games, secondary Card; Play: Card)                           |
| Age rating                   | 17+ / Mature 17+ (simulated gambling, no real money; see "Content" below)       |
| Privacy policy URL           | https://smarter.poker/privacy                                                   |
| Terms URL                    | https://smarter.poker/terms                                                     |
| Support URL                  | https://smarter.poker/help                                                      |
| Support email                | support@smarter.poker                                                           |
| Marketing URL                | https://smarter.poker/hub/club-arena                                            |
| Copyright                    | 2026 Smarter Software Inc.                                                      |

## Description (both stores, under 4000 characters)

Club Arena is where your poker club plays.

Join a club with an invite from its owner or agent, take a seat, and play the
games your club runs: no-limit hold'em and pot-limit Omaha cash games,
scheduled tournaments, bomb pots, run it twice, straddles, insurance and
spin-style sit-and-gos, all dealt by a server that every player at the table
trusts equally.

Made for the phone in your hand. Portrait, one thumb, with a table strip that
lets you sit at several tables at once and switch between them yourself. Every
deal, flip, chip push and celebration plays at the speed you choose, with
haptics when it matters and the screen kept awake while you are in a hand.

For club owners and agents, Club Arena is also the back office: a member
roster, agent hierarchy, rake and settlement reports, promotions, a bad-beat
jackpot and a leaderboard, all inside the same app.

What you should know:

Chips are club play credits. Smarter.Poker does not sell, redeem or pay out
chips and assigns them no monetary value; any arrangement between a member and
their club's agent is private and off-platform.

Diamonds and VIP membership are bought inside the app through the App Store /
Google Play. Diamonds unlock cosmetics, throwables and table themes; VIP adds
rabbit hunt, stack in big blinds, offline protection, auto time bank and a
daily diamond bonus. VIP renews monthly or yearly through your store account
and can be cancelled there at any time.

You must be 18 or older to create an account.

Club Arena is part of Smarter.Poker, the poker training and community platform,
and uses the same account.

## Keywords (iOS, 100 characters)

poker,club,holdem,omaha,tournament,sit and go,cash game,private club,spin,cards

## What's new (first release)

The first release of Club Arena for iPhone and Android: your club's cash
games, tournaments and spins on your phone, with in-app diamonds and VIP,
notifications for open seats and starting events, and sign-in with your
Smarter.Poker account.

## Content and rating answers

- Simulated gambling: YES. Poker with club play credits that have no monetary
  value and cannot be cashed out through the app. No real-money gambling, no
  prizes of monetary value awarded by Smarter.Poker.
- Loot boxes / random items for money: NO (spins are game formats, not
  purchases with a random reward).
- User-generated content: YES (table chat, club names, avatars); reported and
  moderated by club staff; players can block and report.
- Violence, sexual content, drugs, profanity: NO / NO / NO / mild (chat is
  filtered).
- Contests: NO.
- Unrestricted web access: NO (the in-app browser opens smarter.poker pages
  only).

## Data safety / privacy nutrition (what the app actually collects)

| data                                                                  | collected | linked to identity | purpose                             |
| --------------------------------------------------------------------- | --------- | ------------------ | ----------------------------------- |
| Email, username, avatar                                               | yes       | yes                | account                             |
| Date of birth                                                         | yes       | yes                | age check (18+), asked once         |
| Gameplay and club activity                                            | yes       | yes                | app functionality, reports          |
| Purchase history                                                      | yes       | yes                | entitlements (via RevenueCat)       |
| Push token / device id                                                | yes       | yes                | notifications, only if turned on    |
| Crash data                                                            | yes       | no (no email)      | first-party diagnostics                |
| Product analytics                                                     | optional  | yes                | only after in-app consent (PostHog) |
| Precise location, contacts, photos, health, financial account numbers | no        |                    |                                     |

Data is encrypted in transit. Users can request deletion in Settings > Delete
Account (removes the profile, wallet and push tokens). No data is sold; no
third-party advertising SDKs.

## Screenshots to take (once a device exists)

iPhone 6.7" and 6.5" (Play: phone, 7" tablet, 10" tablet), each with a
one-line caption in Title Case:

1. A cash table mid-hand, hero cards showing. "Your Club's Tables, In Your Hand."
2. The multi-table strip with three tables. "Play Several Tables. Switch When You Choose."
3. The tournament lobby with a scheduled event. "Tournaments, Spins And Bomb Pots."
4. The club home with the roster and leaderboard. "Run Your Club From The Same App."
5. The marketplace VIP tab. "Diamonds And VIP, Through The Store."

Play also wants a 512x512 icon and a 1024x500 feature graphic, both exported
from `resources/icon.png`.

## Review notes (App Review / Play policy team)

Demo account: a review account Dan creates (never the service identity or his
own); email + password in the review notes field, already a member of one
club with chips on the wallet and one tournament scheduled inside the review
window.

Notes:

- Sign-in is email and password only. There are no third-party sign-in
  buttons in this build, so Guideline 4.8 does not apply.
- Chips are club play credits. Smarter.Poker does not sell, redeem or pay out
  chips and assigns them no monetary value; any arrangement between a member
  and their club's agent is private and off-platform.
- All purchases (diamonds, a consumable; VIP monthly and yearly, auto-renewing
  subscriptions) go through the store's own billing. Restore Purchases and
  Manage Subscription are on the Marketplace > VIP Membership tab.
- Account deletion: Settings > Delete Account, in the app.
- Age: the app asks a date of birth at sign-up and refuses under 18.
- Notifications are opt-in from Settings; nothing is sent until the user turns
  them on.
- The in-app browser opens only smarter.poker pages (the community, training
  and support areas of the same platform).
- Over-the-air updates (Capgo) deliver JavaScript, CSS and copy fixes only;
  any new capability ships as a new binary through review (Guideline 3.3.2).

Budget two review rounds. The first rejection, if any, is most likely to be
about simulated gambling wording or the demo account; both answers are above.
