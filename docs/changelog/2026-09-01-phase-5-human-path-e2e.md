# Phase 5 Of 6: Human-Path End-To-End Safety

## Scope

Phase 5 exercises the human decision surfaces that earlier engine and source
tests could not prove: the World Hub auth handoff, Cashier reachability, seat
hold timing, 375px mobile fit, Insurance, and Rabbit Hunt.

No Club Bank, Deep Stack Society balance, horse funding, player membership, or
chip balance was changed. The live browser paths stop before every purchase.
The financial decision browser harness has no backend writer at all.

## Defects Closed

- Insurance hid its modal before the server answered. A rejected purchase or EV
  cashout therefore left the player with no visible recovery path. The modal
  now remains open on refusal, reports the reason through the existing safe
  toast boundary, and closes only after server success.
- Insurance actions had no same-frame mutex. All decision buttons now share one
  synchronous single-flight guard, expose a busy state, and cannot submit twice
  during an async response.
- The Insurance panel was not exposed as a named modal dialog and Escape did
  not answer the offer. It now owns focus, dialog semantics, a labelled timer,
  explicit button types, and a captured Escape path that sends the same final
  decline as the visible No button.
- Rabbit Hunt relied on React state alone for duplicate prevention. A
  synchronous ref now closes the pre-render double-tap window before the paid
  endpoint can be called twice.
- Rabbit Hunt's accessible name omitted the diamond price. A paid reveal now
  announces the same live server price shown on the tile.
- Rabbit Hunt subscribed to auth a second time inside the tile. TablePage now
  passes the authenticated player identity it already owns.
- The metadata-only `rabbit_hunt_reveals` production ledger existed but had no
  writer. Successful reveals now record player, table, hand, and diamonds
  charged. The obsolete `rabbit_hunt_offers` card-storing table remains unused
  so unseen cards never enter a broadcast or persistent client-readable path.

## Browser Certification

`playwright.financial-decisions.config.ts` mounts the production Insurance and
Rabbit Hunt components in Chromium at 375 by 812 pixels. The fixture is gated
to development and its dedicated CI build flag; normal production navigation
cannot open it. It proves:

- the full Insurance dialog and pinned actions fit the viewport;
- a same-frame double activation sends one request;
- a rejected purchase leaves the dialog visible and reusable;
- Escape sends one final decline and removes the dialog;
- paid Rabbit Hunt announces five diamonds;
- a same-frame double tap sends one reveal request;
- successful reveal removes the tile.

The required CSS Beat E2E job now invokes this dedicated real-component gate.

## Production Baseline

A read-only production query on 2026-09-01 found 702 insurance offer events,
three insurance transactions, and zero rows in both legacy Rabbit Hunt tables.
Source tracing showed that the zero count was an observability gap, not proof
that the endpoint was unwired: the paid engine RPC and private response path
were covered, while the safe reveal ledger had no insert call. The Phase 5
writer closes that gap without storing cards or changing payment behavior.
