# A Diamond Tournament Close Locks Every Wallet In Id Order

Turbo Tuesday PKO `bc8e3d86-d970-4992-9e4d-15a2d4da3261` (351 Diamond entries) was decided at 23:03 UTC on 2026-10-21, and every terminal finish was refused with `40P01 deadlock detected`. The terminal path reaches `fn_poker_diamond_tournament_close_custody`, which released each entry custody in registration order; each release locks the owner's `profiles` row. Live hand commits lock the same players' rows in id order (`fn_poker_diamond_settle_cash_hand ... ORDER BY p.id FOR UPDATE`). Hundreds of sequential locks in a different order against continuous traffic from the same players deadlocked on every attempt.

The close now takes every releasable owner's profile lock once, in id order, before its release loop; each release then re-locks a row the transaction already holds. Amounts, receipts, custody states, release order and the guarantee release are unchanged. The migration is guarded by the installed predecessor md5 and pins its exact postimage, owner, security definer, search path and ACL.

Native PostgreSQL 17 proof: the exact production predecessor (md5 `634cc0054bb96b9bb775f601831c57ee`) deadlocks against an id-ordered hand commit in the reproduced interleaving; after the migration the same interleaving completes for both sessions and custody closes.
