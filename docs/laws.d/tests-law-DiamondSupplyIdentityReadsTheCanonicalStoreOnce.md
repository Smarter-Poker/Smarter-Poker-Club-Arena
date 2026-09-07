# tests/law/DiamondSupplyIdentityReadsTheCanonicalStoreOnce.law.test.ts

Diamond supply is SUM(profiles.diamonds) read once (DR10): the user_diamonds / user_diamond_balance / diamond_wallets mirrors are compared for equality and never added, drift is measured against the previous profiles sum rather than the previous stored total, the diamond_wallets mirror leg upserts, the time bank sink prices from feature_pricing and debits through deduct_diamonds with a reference, and the unfunded union grant and unjournaled club vault debit are recorded by rule name while staying LOG-ONLY
