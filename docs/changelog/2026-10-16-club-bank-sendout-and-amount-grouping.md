# Club Bank Transfer Form And Amount Grouping

The Club Bank transfer form now uses the same approved player, wallet and amount row artwork as Cashier Send Out, with the selected destination wallet and its actual balance. Recipient selection, Claim Back, the Transaction Ledger (including filters, export and reversal), mint access, authorization, confirmation and durable transfer handling remain in the wallet-owned dialog.

Both Cashier transfer row types clip the nine orphan pixel rows below the artwork's complete closing frame. The artwork retains its native aspect ratio. Editable amounts normalize grouping after each edit before inserting thousands separators; sequential typing no longer freezes a separator in `1,00000`. Invalid nonnumeric spelling remains visible and is refused by submission validation.

Regression coverage exercises sequential grouping and exact numeric submission, the Bank's selected player/source/amount form, persisted ledger read and export access, existing financial dialog guards, and the shared frame clipping boundary. Local rendered fixtures cover 375px, 393px and desktop; fixtures perform no financial writes. Publication and live proof are recorded separately in the task checkpoint.
