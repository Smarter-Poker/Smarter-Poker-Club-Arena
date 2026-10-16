# Simple Cashier Header

Dan's direction on the Simple Cashier header (2026-10-16):

- The "Live Ledger" pill is gone. An offline cashier still shows "Locked".
- The "Simple Cashier" caption is gone; Advanced still labels itself.
- The club leads the glass: no toolbar row above it in Simple, a 72px logo with the club name and a "Choose" dropdown chevron stacked beside it, and the Advanced switch on the same row.
- "Balances Synchronized" no longer prints. Screen readers still announce it, and any other state (offline, reconciling, an error) still shows on screen.
- Request Cash Out is a compact button (260px wide) in the same painted frame as the action dock's "Tap A Player To Select" (`cashier-action-dock-v1.png` at its own ratio), with its label in the dock's lit blue ink. Nothing is drawn in CSS.
