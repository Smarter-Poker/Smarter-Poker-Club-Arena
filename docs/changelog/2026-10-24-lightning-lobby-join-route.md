# Lightning lobby join navigation

Joining Lightning from the selected game panel now keeps the Lightning entry route open. Closing the panel before navigation scheduled the lobby query-string effect, which could overwrite the new route and leave the player in the lobby.

The Lightning route unmounts its panel naturally. Other table and game joins retain their existing close and admission behavior. A mounted ClubHomePage test with a real React Router reproduces the original failure, then verifies the destination remains after effects settle, without submitting a join or purchase.
