Tournament Blinds Follow The Rest Between Hands

A level update during the rest between hands could leave the next hand using the blinds fetched before the rest. The regression reproduced a 20-chip big blind and 36-chip starting pot where the newly effective level required 40 and 72.

Moves the existing budgeted tournament blind read to the end of the rest, before the caller rechecks pause and lease authority. Seats and cash rake remain prepared under the rest. There is still one blind query per attempted tournament hand, with the same retry and time budget. The active HandController retains its own original stakes.

The nine tournament blind/sit-out tests and server types pass. The independent input-read test now verifies that tournament blinds are reserved for the later deal boundary.
