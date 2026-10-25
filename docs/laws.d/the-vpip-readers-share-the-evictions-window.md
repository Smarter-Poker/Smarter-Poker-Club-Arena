# tests/the-vpip-readers-share-the-evictions-window.law.test.ts

The maintain-VPIP window (the sitting in the game, never earlier than the game's `vpip_floor_since`) is defined once in `fn_nit_sitting_since`, and the enforcer (`fn_nit_check`) and both readers (`fn_nit_status`, which horses steer by, and `fn_cash_vpip_status`, the player's own tracker) all call it, so no reader can again judge a different sample from the one that stands a seat up.
