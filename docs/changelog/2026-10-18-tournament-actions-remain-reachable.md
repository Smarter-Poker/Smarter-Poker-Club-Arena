# Tournament Actions Remain Reachable

Dan reported missing upper-right registration, global navigation covering tournament content in both arenas, and the duplicate arrow Lobby control.

## Source correction

- `TournamentDetails.tsx` previously rendered its only register/late-register/unregister/seat action in the bottom footer (previous lines1965–2165). Move the existing state machine, handlers, busy guards and entry eligibility intact into the upper-right header. It stays reachable on every tab in the routed page, table lobby tab and full-screen tournament popup.
- `MultiTablePage.tsx` previously overlaid a second arrow Lobby button over the event's status/title (previous lines4202–4214). Remove that button and its unused callback/styles. The existing GlobalHeader Back remains wired to in-tab history and the tournament stack; mounted games are preserved.
- `TournamentDetails.css` only reserved measured bottom navigation on routed pages. The table lobby now explicitly declares `inLobbyTab`, reserving the same live occupied height; full-screen tournament sheets keep their own bounded parent without an unrelated navigation deduction.
- `useHideFooterOnScroll.ts` previously treated the first scroll's final position as its starting anchor. Count the first genuine downward flick from zero, preserving the existing jitter, short-list, upward and bottom reveal rules.
- `clubFooterVisibility.ts` previously lost Diamond navigation on the shared `/tournaments/:id?club=diamond-arena` route and displayed chip cashier/market doors. Retain explicit Diamond scope for tournament list/details only; operator descendants remain excluded.

The tournament shell keeps its separately approved October4 industry-standard presentation. This is a reachability correction, with no replacement frame, price change, registration API change or engine activation dependency.

## Verification

Initial local focused run:197 assertions pass. Compiler passes. Copy gates pass. New header/first-scroll regressions fail on the preimage (3 selected failures) and pass after correction; original failure retained. Final111 focused assertions plus197 broader neighboring assertions,20 UI-gate assertions, all copy gates, TypeScript and production build pass. Real-component phone renders375/393/430 and desktop1280 have no horizontal overflow; short landscape812 scrolls through the final row above navigation. The actual shared footer hook hides on scroll. Protected delivery and live verification are recorded in the existing audit checkpoint as they complete. No production registration, wager or transfer was submitted by the agent.

Real-time law: existing tournament discrete events and registration hook retained; this change repositions controls and responds to user scroll, with no snapshot diff or polling added.
