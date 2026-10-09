# Leaderboard Union Shortage Fixture

The original union shortage setup failed with SQLSTATE 23514 inside the owner-to-player disbursement before leaderboard settlement. Its exact nested cause is not established. Retain that failed operation as evidence.

Build the union shortage with the existing service-role Union Promo to affiliate Club Promo transfer. Independently assert the empty union float, positive affiliate float, unchanged player and Bank balances, one keyed journal leg and one transfer history receipt. This also tests that an affiliated program cannot use the club float as a fallback. Standalone setup retains its passing owner disbursement; leaderboard authority and expected refusal remain unchanged.

Fixture-only correction. No production function or frozen migration changes. Current-schema runtime qualification remains required.
