# tests/a-new-clubs-first-chips-come-from-the-mint.law.test.ts

A new club's first 100,000 chips come from the Mint and stay in the club: the opening grant journals issuance_reserve -> club_treasury, writes the ca_mint_ledger register linked to its journal row, keeps its club_opening_grant transaction, and the union clawback refuses to take a treasury below the opening grant
