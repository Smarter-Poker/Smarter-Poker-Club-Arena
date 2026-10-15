# Action And Madness Say What They Change (2026-10-15)

Dan, verbatim: "WHEN CASH GAMES ARE DISPLAYED WITH 'CLASSIC' 'ACTION' AND
'MADNESS' THERE SHOULD BE A DESCRIPTION NEXT TO THEM FOR ACTION AND MADNESS
EXPLAINING WHAT CHANGES THE VARIATION OF THE GAME."

His screenshots were three spade PLO 1/2 cards whose style line read only
ACTION, CLASSIC and MADNESS.

## What changed

- `cashTemplateNote(template)` in `src/config/cashGames.ts` returns the
  template's own blurb (the same words the New Cash Game picker shows) for
  Action and Madness, and nothing for Classic or an untemplated table:
  - Action: Small Blind Ante, VPIP Floor, Double Board Bomb Every 15 Minutes
  - Madness: Big Blind Ante, High VPIP Floor, Double Board Bomb Every Orbit

  Read against `fn_cash_template_defaults` on production the same day:
  Action is an SB ante, 30% VPIP floor and a 2-board bomb every 15 minutes;
  Madness is a BB ante, 50% VPIP floor and a 2-board bomb every orbit. The
  note carries no figures, so a host override of a number never makes a card
  say something untrue.
- The lobby card data (`ArenaGameCardData.styleNote`) carries it for every
  cash game.
- Phone cards: the spade PLO, four-bay PLO and spade NLH cards print the
  style word and, beside it, the note (Inter, the muted ink, a hairline in
  the master's blue between them). The row keeps the subtitle's left edge,
  runs out under the status pill to the header well's right wall and takes a
  second line before it would shrink under 85%. Zones are measured on each
  master: below the pill's rim and above the well's divider.
- Desktop: the board row and the premium card print the note after the style
  word.

Pinned by `tests/unit/actionAndMadnessSayWhatTheyChange.test.tsx`.
