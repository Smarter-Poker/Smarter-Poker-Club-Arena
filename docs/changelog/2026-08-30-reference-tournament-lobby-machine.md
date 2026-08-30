# Tournament Lobby is one premium machine

The Tournament Lobby no longer renders a generic modal header, a separate
“Game Details” banner, rounded SaaS cards, and a detached Share/action footer
inside a stretched lobby image.

## What changed

- The Play Records navigation and all seven tournament tabs now occupy two
  connected hardware rails.
- The event name, guarantee, ID, share control, buy-in, description,
  registration state, and live action are fitted into one event control bay.
- Registration, unregister, late registration, watch, and take-seat behavior
  is unchanged; only its physical placement moved into the approved machine.
- Entries now uses a riveted three-stat bay and one continuous steel register
  with divider rows and blue satellite-winner states.
- Details, Blinds, Ranking, Entries, Unions, Tables, and Rewards share the same
  carbon, steel, bevel, typography, and scrolling vocabulary.
- The in-game lobby popup uses the same machine as the routed lobby. Its old
  rounded “Tournament Lobby / Close” header was removed; dismissal is now a
  compact control in the machine rail, plus the existing backdrop and Escape
  behavior.
- The routed lobby is full bleed and suppresses the duplicate generic Play
  Records rail because that navigation is already part of the machine.
- Desktop and phone layouts preserve the same connected hierarchy and scale
  the rail and stat geometry without adding side gutters.

## Verification

- Desktop reference capture: 783 × 783.
- Phone reference capture: 390 × 844.
- `npx tsc --noEmit`
- `npx vitest run tests/unit/premiumTournamentConsoleContract.test.ts`
- `npm run build`
