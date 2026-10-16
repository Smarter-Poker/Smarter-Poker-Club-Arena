# Simple Cashier Header

Dan's direction on the Simple Cashier header (2026-10-16):

- The "Live Ledger" pill is gone. An offline cashier still shows "Locked".
- The "Simple Cashier" caption is gone; Advanced still labels itself.
- The club leads the glass: no toolbar row above it in Simple, a 72px logo with the club name and a "Choose" dropdown chevron stacked beside it, and the Advanced switch on the same row.
- "Balances Synchronized" no longer prints. Screen readers still announce it, and any other state (offline, reconciling, an error) still shows on screen.
- Request Cash Out is a compact lit pill (220px wide). The art is the approved global-header pill (`images/global-header/hub.png`) with its icon and word cut away by surgery and its right cap mirrored for the left, so nothing is drawn in CSS.
