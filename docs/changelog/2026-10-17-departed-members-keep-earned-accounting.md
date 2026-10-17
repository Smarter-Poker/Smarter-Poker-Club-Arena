# Departed members retain their earned accounting wallet

The original October 5-12 round 2 settlement rolled back when the canonical commission stage credited a departed member. The lifecycle trigger rejected every update to an already departed row, including an update limited to `chip_balance` and `updated_at`. The preserved historical commission windows include 24 departed club memberships; departure does not forfeit their earned commissions.

Migration 20261017053808 changes that owning trigger function only. The existing trusted server identity may update those two wallet fields when every other row field remains identical. Browser updates remain refused, and membership identity, lifecycle, departure history, status, role, hierarchy and all other fields remain protected. The existing depart and rejoin paths retain their original allowance. Canonical accounting still owns payment authorization, amounts, ledger writes, balance conservation and idempotency.

The migration pins the actual guard and caller definitions, private security metadata, declared trigger attachment and inventory seal. It writes no money or membership data, changes no grants or trigger attachment, and preserves the current forty-source evidence generation. The maintained installer binds its exact bytes through the existing bounded accounting admission.

The focused native regression must reproduce the canonical wallet update failing before installation and passing afterward, preserve all other membership fields, refuse browser and mixed-field writes, and preserve the existing lifecycle allowance. Production installation and the original financial settlement require separate durable verification.
