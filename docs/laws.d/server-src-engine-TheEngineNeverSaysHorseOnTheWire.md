# server/src/engine/TheEngineNeverSaysHorseOnTheWire.law.test.ts

Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE OR
USE A DEVELOPER TOOL AND FIND THIS OUT." Found 2026-09-08 after every database
door was shut: all three client payloads the engine publishes through
TableStateHub (the resync, the hand broadcast, the between-hands roster)
carried `is_horse` on every seat, so the WebSocket frame in any player's
Network tab labelled every horse at the table on every state change. The flag
stays on the engine's own Player record for the horse's input device (10.5)
and is never serialised to a client; the client's snapshot shape no longer
declares it. The law pins the engine's payload builders and the client shape.
