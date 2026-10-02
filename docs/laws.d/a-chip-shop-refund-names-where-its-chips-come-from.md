# tests/a-chip-shop-refund-names-where-its-chips-come-from.law.test.ts

The chip branch of fn_refund_shop_purchase declares its counterparty (issuance_reserve, category refund, key ca-shop-refund-<purchase>) and restores its caller's declaration, instead of reaching the guarded fn_credit_chips undeclared and being refused by name; fn_credit_chips keeps a category its caller declared (2026-10-02)
