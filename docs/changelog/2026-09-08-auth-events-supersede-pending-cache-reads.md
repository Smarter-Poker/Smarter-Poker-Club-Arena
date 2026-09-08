# Auth events own the token cache

The cache's initial session read and slow token lookup could finish after a
sign-out or new sign-in and adopt the old token. That stale token then became
the fast path for table connections and API calls.

Each auth event now advances a generation. A session read can adopt its result
only while its generation is current. A superseded slow lookup returns the
current usable cached token, or null after sign-out, including when the old
lookup rejects. An ordinary unsuperseded lookup still refreshes the cache.

Three regression cases failed before the change: initialization after sign-out,
a slow lookup after sign-out, and a slow lookup after a new sign-in. The normal
lookup case provides the positive control. This change does not close existing
sockets on logout; that transport ownership audit remains separate.
