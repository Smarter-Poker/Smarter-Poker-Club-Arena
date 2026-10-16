# Simple Cashier Header

Dan's direction on the Simple Cashier header (2026-10-16):

- The "Live Ledger" pill is gone. An offline cashier still shows "Locked".
- The "Simple Cashier" caption is gone; Advanced still labels itself.
- The club logo prints at 72px, and "Choose" carries a chevron that turns when the club list opens beneath it.
- "Balances Synchronized" no longer prints. Screen readers still announce it, and any other state (offline, reconciling, an error) still shows on screen.
- Request Cash Out is a button on its own painted plate. The plate is the lit primary plate lifted from the Spade Console plates master (`bottom-plates.png`, 401 x 155 from 507,31), so nothing is drawn in CSS.
