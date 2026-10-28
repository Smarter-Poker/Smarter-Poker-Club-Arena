# MTT horse add-ons use a 74% random chance

Owner instruction October 27 replaces the October 25 100% add-on policy. Each eligible horse/event pair is selected with the existing SHA-256 participation draw at a 0.74 threshold. Repeat offers and process restarts keep the same decision, so declined horses cannot reroll into acceptance. All MTT add-on offers use this selector, including Free Buys.

The early versus break timing split, seat/funding eligibility, canonical purchase RPC, idempotent receipts, amounts and chip grants are unchanged. Existing purchases stay purchased.

Regression coverage pins 0.74, all 1000 participation buckets (740 selected), sample distribution, event variation, stable declines and timing. The new expectations fail against the previous 100% source. This is engine runtime work and follows the existing protected engine release and daily maintenance route; source integration alone is not live delivery.
