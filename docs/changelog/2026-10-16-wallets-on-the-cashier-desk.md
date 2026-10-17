# Wallets Open On The Cashier Desk

Dan's direction (2026-10-16): the Union Bank, the Promo Wallet and the Diamond Wallet should look, feel and work like the Cashier, without the bulky frames.

- New `WalletDesk` shell (`src/components/wallet/WalletDesk.tsx` and `.css`): the Cashier heading, an identity row (logo or art, name, a line under it, a white Close), hairline directory rows with a select box, and the painted Cashier action dock with its centred line. Nothing is drawn in CSS: no radius, gradient or hover.
- **Union wallets** (`UnionWalletModal`): the union's logo leads. Clubs and members are rows you tap to select, and the dock carries Pull Back | Ledger | Send Out. The amount is asked for on the riveted sheet, as the Cashier's Send Out asks on its own console. Every route, guard, operation id, RPC and refusal sentence is unchanged. The Spin Reserve stays read only.
- **Diamond Wallet** (`DiamondWalletModal`): the two custody figures, the filter words and the history as rows, with Send Diamonds | Buy Diamonds on the dock. A transfer opens on the flat-crested sheet. Every close path still holds shut while a transfer travels, and Escape closes the sheet first.
