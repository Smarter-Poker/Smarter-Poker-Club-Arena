# Manual Lightning Top-Up With A Verified Sit Out

The explicit `financial_top_up_sitout` witness uses the existing normal Sit Out control, waits for the persisted anchor flag and all outstanding reserved/participant hands to settle, and confirms that the exact pool-slot participation count does not grow while paused. Only then does it perform the existing single manual Top Up gesture and original authoritative receipt/ledger proof.

A single normal I'm Back gesture runs in cleanup, including after a refused or unknown add-on. Persisted return, unchanged pool/seat/occupancy/cash-session/opening identity and stable serving identity must be verified. Sit Out itself preserves baseline; a successful add-on legitimately increases baseline by the verified applied amount, through the existing cash-session owner. Unknown cleanup remains unknown and no action is retried. The original 240-second ceiling and cleanup reserve remain.

Existing financial modes, auto-top-up behavior, product/engine/DB code, funding rules and hand guards are unchanged. The new mode requires the independently protected and live pool Sit Out routing fix before use. Regression cases cover delayed persistence, overlapping old hands, new formation during pause, normal refusal and return/readback failures; no production financial operation was run during source qualification.
