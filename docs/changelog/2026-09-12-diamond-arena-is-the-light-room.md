# Diamond Arena Is The Light Room

Status: Phase 7 In Progress. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## The Ask

Dan, September 11: "ONLY DIFFERENCE BETWEEN THEM IS DIAMOND ARENA SHOULD BE WHITE, OR LIGHT SCHEMA, CLUB ARENA DARK", to be done in this phase rather than the last one.

It lands directly on top of an older instruction from August 30: "THE WHOLE BACKGROUND SHOULD BE SOLID BLACK AND ALL THE SAME COLOR", which is written on the body rule in `club-engine.css`, on `.club-home`, on `.lobby-top` and in `AppLayout`, and which a previous piece of work enforced by deleting a per-route art system.

The two only disagree if the light one is global. Scoped, they are one instruction: black is the rule for the chip estate, and the Diamond Arena is the one room that is not part of it. Every note carrying the black instruction is left exactly as it was.

## A Third Attribute, Not A Fourth Writer

`<html>` already carried two theme attributes, and they were ONE attribute until they fought.

- `data-theme` is the player's interface mode, `dark` or `light`, chosen in Settings and written by three owners: the settings store, the MasterBus `UI_THEME_CHANGED` handler, and `Shell`.
- `data-color-theme` is the table felt palette.

They were split after a production incident in which the app served the light token palette to players who had chosen dark, because a stale felt setting still held the value `light` and the felt attribute still selected the interface palette. That postmortem's conclusion was that one attribute with two meanings is decided by whichever writer ran last.

So this is `data-arena-scheme`, its own attribute, with one writer and one input. It answers where the player IS; the other two answer what the player PREFERS and what the felt looks like. It never reads or writes the player's setting, so a player who chose dark does not have their choice silently rewritten by walking into a room, and a player who chose light finds this room already satisfies it.

`html[data-arena-scheme='light']` is specificity 0,1,1 against `:root`'s 0,1,0, so the palette wins over both token sheets whatever order they load in, and over a bare `[data-theme='light']` too.

## Where The Answer Comes From

`arenaSchemeFor(pathname, selectedClubId)` takes the same two inputs `shouldShowClubFooterFor` takes, for the same reason: the in-table "+" opens a club lobby as a TAB while the URL stays on `/table/<id>`, so a route gate alone would put the chip estate's chrome around the Diamond lobby. It is written from `App.tsx`, which is the one place already holding both.

## It May Not Lighten A Table

`tests/seat-plates-stay-dark.law.test.ts` holds seat plates, the felt and the timer dark in every interface scheme. That law is about hole cards being readable rather than about Club Arena being dark, so it binds here too, and the new law enforces the same token list a second time: that one reads `design-tokens.css`, and this scheme is declared in the globally loaded sheet it cannot see. A light FELT, if one is ever wanted, is a table theme preset.

## What Was Actually Painted

The palette is declared in `club-engine.css` rather than `design-tokens.css`, because only the first is loaded globally; the second reaches the DOM through `@import` in seven component sheets. A scheme that has to hold for a whole room has to be declared where the whole room can see it.

Measured on the live page, with the scheme injected into production's own DOM before any of this was written: of 85 elements over 80x40, **79 carry no opaque background of their own** and follow the ground. The ground is one token, so those 79 came with it. The six that did not are the club card panels, which are artwork.

The Diamond lobby is the shared `ClubHomePage`, which Phase 7 pointed the Diamond route at deliberately, so the light scheme could not be a fork of the page. It is the same page in a different room. That sheet holds 357 colour literals and almost all of them are accents, glows and state colours that read correctly on either ground; what decides whether a page is light or dark is a much smaller set, and only that set is overridden: the page ground, the strips on it, the plates raised off those, and the hairlines between them. An accent changed upstairs does not have to be changed twice.

## One More Thing, From The Same Message

The Diamond Arena card on the home carousel said **ACTIVE PLAYERS**. Dan asked for "JUST 'ACTIVE' AND THE NUMBER UNDER IT", and it was also the one label on that carousel that did not match its neighbours: every chip club card says ACTIVE. It says ACTIVE now. The freeroll clock beside it was already there.

## Not Yet

The club card panels, the global header and the table page keep the dark treatment. The first two are artwork with their own guards, and the third is bound by the seat-plate law. Surfaces reached from the lobby but owned by other sheets will light as they are converted; this pass covers the room and the lobby.
