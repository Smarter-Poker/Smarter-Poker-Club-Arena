# Player Search Workspace Regression Proof

The existing production roster workspace test still expected manual Name ordering after returning from a Player Record with an active query. Name searches now intentionally display disabled Player Name Matches ordering. The test checks that state, then clears the query and verifies the saved Name sort is restored and enabled.

This changes verification only. The separately passed focused live name case and actual Kings Mikey UI proof remain valid. The broader run also has five failures at its initial Simple-mode assertion; those remain unresolved observations and this correction does not claim to repair them. No production behavior, migration, fixture cleanup or release workflow changes.
