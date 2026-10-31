# Unknown union routes stop before UUID queries

An unknown union slug was returned unchanged by the resolver. Opening an old or
invalid union link therefore sent the slug to the detail page's data and online
queries and the navigation rail's authority calls, producing PostgreSQL 22P02.

The resolver now returns null for a confirmed missing union and throws lookup
failures. The route hook retains distinct loading, ready, not-found and error
states and supports retry. The detail page uses its existing empty/error views;
the navigation authority calls stop when no UUID was resolved. Valid UUID and
cached-slug behavior is preserved. No database or engine change is required.

Regression checks cover missing slugs, lookup failure followed by retry, cached
success, network-free UUIDs and route changes while resolution is pending.
