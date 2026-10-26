# The 62 replacement horses join their clubs and are funded through the Mint

Owner order, 2026-10-26 08:15 America/Chicago: "MAKE SURE THE 62 NEW HORSES CAN PLAY, FUND THEM ALL WITH 10,000 CHIPS. SEND THEM TO THE CLUBS THROUGH THE MINT, TO THE CLUBS MAIN BANKS, THEN DIRECTLY TO HORSE WALLETS."

The `Original patterned horse replacements` workflow created the 62 replacement identities for the October 6 patterned retirements (eligible fleet and roster 1,000). Creation deliberately wrote no membership, wallet or seat, so the new horses could not play.

Each new horse now holds an active membership and a 10,000-chip player wallet in the three clubs its retired original belonged to: KINGS CLUB, Midway Union and The Felt Society. Only existing platform doors were used, with no direct balance or ledger write:

1. `fn_ca_mint('chips','club', ...)`: 620,000 chips into each club's main bank, op ids `horse-replacements-20261026:<club>`, attributed to the club owner.
2. `fn_join_club` as each horse (explicit-join source), then `fn_review_join_request` by the owner where the club requires approval (Midway Union, The Felt Society).
3. `fn_club_bank_send(..., 'player_wallet', ...)`: 10,000 chips to each horse, retry key `md5('horse-fund-20261026:<club>:<horse>')`.

A rolled-back probe of every step ran first, per club. A first all-clubs probe deadlocked on `clubs` rows with live writers and rolled back completely (verified: no mint, claim or membership). The committed run used one club per transaction, half a club per batch, `lock_timeout` 3 s.

Verification: 62/62 active members in each club; 62 `club_bank_send` rows and 62 keyed ledger rows per club; each club bank returned exactly to its pre-mint balance (42,865.64; 22,005,070.62; 61,286.46), so all 1,860,000 issued chips sit in the 62 horses' wallets. Within minutes 19 of the new horses were seated and 6 had played hands.
