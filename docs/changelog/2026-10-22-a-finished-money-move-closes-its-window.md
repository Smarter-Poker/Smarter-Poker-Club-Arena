# A Finished Money Move Closes Its Window

Dan, 2026-10-22: "when you click pull or send... you shouldn't have to 'x' off. It should simply give the toast ... and close. Same thing should happen when sending or pulling chips from regular cashier transactions."

- **Union Bank** (`UnionWalletModal`): a confirmed pull or send (club, member, promo, or an already-processed replay) now shows its sentence as a toast and closes the wallet. A refusal or an unknown outcome still stays open with its reason, as before.
- **Club cashier** (`WalletCashierModal`): a confirmed send or claim (Club Bank, Agent Wallet, Promo Wallet) and a confirmed ten-minute claim back now close the cashier after their existing success toast.
- **Cashier Trade page**: Send Out already closed on a clean batch; a confirmed ten-minute claim back now closes the Claim Back sheet too.
- Copy: "Pulled ... From The The Felt Society Club Bank" is now "From The Felt Society Club Bank" (`theClub()`).
- `useOptionalToast()` reads the same ToastContext for surfaces that can render outside the provider; it is not a second toast system.

Tests: two new Union Bank cases (closes after a confirmed pull; stays open on a refusal) and the cashier D-02 case now expects the cashier to close itself after the send lands.
