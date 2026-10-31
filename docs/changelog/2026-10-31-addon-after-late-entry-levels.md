# Add-ons follow the last late-entry level

Afternoon Deep Stack opened its add-on at elapsed minute 80 while current_level was 3 and late_reg_levels was 8. Fifty purchases were real, not a display count. The entry-close RPC followed the earlier elapsed clock and instructed the engine to open add-ons.

The transition now waits for the configured level boundary. The locked purchase RPC independently refuses early levels, unknown levels, pre-start status and legacy long Free Buy windows. Historical purchase receipts still replay; finalized pools and existing purchases are not rewritten. Existing window finalization remains compatible with the serving engine: refusing an expired window while that engine holds all dealers could prevent level advancement forever. The strict guard belongs at opening and purchase; the new engine owns the corrected pause timing.

All new engine windows, including Free Buy, start only after the committed boundary and every dealer parks. The offer lasts exactly 60 seconds, including within a synchronized break; the independent regular break retains its own pause. Early horse purchase selection is removed. Legacy early Free Buy windows recover at the closing boundary.

The real PostgreSQL regression reproduces early opening and passage to the money boundary before the exact migration, then verifies refusals, level/clock boundaries, Free Buy and immutable receipt replay afterward. Its money core is a sentinel, not an accounting certification. Existing accounting qualification remains required. Runtime tests exercise actual manager/dealer pause boundaries. Engine activation and database installation are separate deliveries.

Durability source contracts now pin the fixed-duration deadline and the held-field purchase worker. Invalid-deadline-before-CAS, durable readback, lifecycle fences, maintenance freezes, and immutable receipt checks remain enforced. The old Free Buy ternary and removed unheld purchase loop anchors reproduced failures and were updated with their replacement mechanisms.
