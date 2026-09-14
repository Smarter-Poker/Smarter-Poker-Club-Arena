# Game details name the ante payer

The Madness game-details panel said every player pays the ante. The engine
charges that game's ante once, to the player in the big blind. The club page
did not select the ante-mode column, and the shared rule description always
assumed a per-player ante.

The table read now carries `big_blind_ante_enabled`, and the shared rule names
the actual payer. A narrow initial response or old cache that omits the mode
shows only the known ante amount until the full table read arrives. It does not
guess the payer from the table name or old settings. The master ante switch
still wins, and canonical per-player tables keep their existing explanation.

Six failures against the old source reproduce the wrong payer, missing mode
read, and unsupported guesses; four controls already passed. Ten dedicated
tests cover these boundaries and the full game-entry view model. The actual
game-details component was rendered before and after at mobile size using
isolated data and no join, queue, or chip operation.
The user approved the shown correction before publication on September 14.
