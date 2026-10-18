# Agents Can Open Their Scoped Club Data

The live JAQK and SHARK audit found that an active agent received a valid
`downline` response from `ca_club_data_screen`, while the outer operations
finance guard blocked the page before it could make that read. Club Data now
uses the staff entry permission already used by the agent workspace. Its
database reader still determines the viewer's exact scope and refuses players.

The nested `/data/advanced` Report explicitly requires control access, matching
its owner, co-owner and admin database gate. It cannot inherit the agent
screen's entry permission, including for a super agent who has finance access.

Regression coverage renders the actual capability guard for agents, super
agents and players, and checks route and navigation registration. The live
before evidence records both real authenticated RPC responses and the blocked
render on both clubs. No ledger, wallet, engine or reporting arithmetic changes.
