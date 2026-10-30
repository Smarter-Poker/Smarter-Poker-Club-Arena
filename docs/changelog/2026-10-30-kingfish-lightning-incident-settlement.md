# House settlement for KingFish's missing-card Lightning incident

The closed Lightning session `bdacfcbf-af5d-441b-a76d-4a52dfa33688` bought in for 400, won 1 in its first hand, then lost 26 through thirteen normal-fold hands while the client showed an observer room without private cards. The Stop Playing transaction closed it with 375. The client cause is repaired separately in PR #8755. Existing settled hands and the initial win remain intact.

The maintained house-settlement precedent `20261026172816` pays from the hosting Midway Union bank into the player's entry club. This incident's cluster and anchor both name Midway Union as their `union_id`; its bank is `union_wallets.chip_balance`, distinct from the virtual arena club treasury. The original 400-chip buy-in journal names KINGS CLUB as KingFish's funding wallet. KingFish's current home-club resolver names a different club, so the settlement must call `fn_credit_chips` with the explicit original KINGS destination.

The exact incident migration pins the closed admission, original funding journal, fourteen completed hand participants, preserved first-hand win and 26 loss total. It uses the existing union debit and explicit club credit primitives inside one transaction. The operation lock, unique original journal key, immutable credit transaction intent and matching settled adjustment make interruption/replay exact once. Any mismatch, missing receipt, insufficient bank, changed incident or freeze aborts the whole transaction. No player wallet row is written directly; no general correction endpoint, schedule, privilege change or fabricated game outcome is introduced.

Qualification and protected delivery are recorded by the owning incident checkpoint. This source file is not evidence that the compensation was paid.
