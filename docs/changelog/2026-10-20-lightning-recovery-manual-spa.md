# Preserve both existing pools during the finite recovery witness

Recovery run 39490060815 rendered both entry routes, then timed out before its
first manual tab observation. The witness used a second full document navigation,
which discards the first pool tab. It also required exactly one engine socket
globally, although other legitimate tables remain connected.

The witness now performs one initial navigation, then uses the existing '+'
context menu, Open Lobby and the secondary View Game control for the exact
target cluster. The visible lobby row is bound by a read-only table identity
lookup to the authorized club and cluster. The normal Lightning entry resolves
the existing own pool. No join, buy-in, scripted navigation, tab eviction or cap
override is added. Missing controls or an ambiguous row remain unknown.
An already restored target pool is selected through its exact visible tab first,
so a player at the real tab cap does not need a new lobby tab. Duplicate target
or hidden target tabs refuse before opening a lobby; no existing game is closed
to create capacity.

Socket ownership follows actual SUBSCRIBE/SUBSCRIBED room identities. A socket
can own a set of rooms; unsubscribe and close retire those bindings. Reconnect
and revocation checks require one live owner for the chosen pool, while other
pool sockets remain valid. Reports retain only bounded room counts, device,
pool, touch step and tab presence/visibility/selection. No URL, token, card face
or raw frame is retained.

Failure UI diagnostics use at most 1.5 seconds of the existing cleanup reserve,
leaving ten seconds for cleanup. The original operation ceiling and existing
partial/unknown evidence rules remain. No actual player operation was performed
to qualify this source. Regression coverage exercises the real witness flow,
missing add controls, duplicate chosen-pool owners and multiplexed room lifetime.
