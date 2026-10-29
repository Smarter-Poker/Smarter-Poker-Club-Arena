# A retained decision reaches the player

A table refresh or live snapshot during a pending original-hand control save correctly withheld its decision token. Once the save finished, the engine could accept the decision but did not publish its token again. The client kept showing "Your Action Was Not Sent", while the turn clock could force a fold.

The original retention lane now notifies its engine when its retained consumers have finished. If a public read withheld the same still-current decision, the engine publishes that decision once. It keeps the existing retention and stale-action guards, never replays a user's choice, and refuses publication for a superseded owner, failed save or changed/completed hand. A private resync cannot consume a publication owed to other subscribers. A failed broadcast does not fail the already-retained financial lane.

The regression uses the actual controller, engine, original retention wiring and resync projection. It failed on the previous source because no ready frame was published. Connected tests cover the current decision, repeated saves, another viewer's resync, changed hands, failed retention, supersession and broadcast failure. Hosted qualification and certified activation/live proof remain required.
