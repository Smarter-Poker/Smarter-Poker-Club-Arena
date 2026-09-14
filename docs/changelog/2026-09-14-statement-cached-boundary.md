# Protect statement pages opened before the cursor upgrade

An old page could already hold a timestamp-only cursor when the new reader was
published. The first compatibility guard rejected newly generated ambiguous
pages, but an existing cursor could still skip its same-timestamp siblings.

The legacy reader now checks an incoming timestamp for multiple matching
account legs before continuing. Such a cursor requires a refresh because it
cannot prove which siblings the old page displayed. The lookup reads at most
two legs from each indexed side. The current component uses its complete cursor
and is unaffected. Account, club-filter and permission boundaries remain intact.

The native regression keeps the original pre-upgrade cursor, reproduces the
remaining omission after the first guard, then verifies refresh refusal after
this migration. It also checks normal continuations, the current reader,
permissions, replay, unexpected definition drift and unchanged ledger data.
