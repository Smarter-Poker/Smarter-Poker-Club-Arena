# Leaderboard verification scope precondition

The replacement browser verification reported an additional keyboard check failure at 393px: its second tab was absent. The product exposes Tournament Stats only in My Clubs scope, while Global scope intentionally has only Rankings. The test had not selected its required persisted scope.

Establish Global and then My Clubs through the existing controls before requiring Tournament Stats and exercising the unchanged keyboard focus, outline and activation assertions. The real transition supersedes an older saved-scope read. All existing performance and accessibility limits remain intact.

This narrow test precondition is required to clear the same failing Client browser verification check. No leaderboard product behavior, financial data, engine or schema changes.
