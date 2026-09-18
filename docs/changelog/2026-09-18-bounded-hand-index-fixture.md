# Bound the hand-index concurrency fixture to its private clock

Required accounting run 35299527220 failed at `index-every-seat-first-a exceeded private deadline`. The native fixture seeded September 13 timestamps while the actual captured every-seat writer advances one hour per iteration until the current time. Its work therefore grew every day and could exceed the 15-second private session deadline on hosted workers. The same source passed locally, so this is not claimed as a locally reproduced timeout.

The fixture now seeds a hand two hours before its private test clock, with cursors one hour before/after that hand. The actual production function, lock gates, deadlines, original deadlock reproduction and all 48 assertions are unchanged. The amended native run passed all 48 assertions, including reproduction of the original unique-index deadlock and both corrected writer orders. The required hosted job must run again on the final candidate.
