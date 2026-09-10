# Diamond Lobby Opens The Shared Wallet

The Diamond access screen now opens the existing Diamond wallet in place, including separate available and in-play balances. It reuses the existing top-up modal and returns to the wallet when that modal closes. The entry performs no route change and does not switch or unmount active tables. Wallet and checkout code load only when requested.

This completes the lobby entry portion of Phase 4, not the transfer release. Funded Diamond gameplay remains closed and atomic player transfers remain under implementation. Tests cover wallet open/close and the wallet-to-checkout-to-wallet transitions.
