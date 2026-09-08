# Engine Connections Outlive The Proxy Idle Pool

The live engine advertised Keep-Alive timeout=5 while Caddy used its default
120-second upstream pool lifetime. Caddy documents that this mismatch can
produce connection resets and 502 responses for non-idempotent requests.
Heartbeat POST 502/EOF errors were observed in the proxy journal. This is a
confirmed configuration mismatch, not proof that every observed failure shares
this cause.

The HTTP server now retains idle connections for 130 seconds, allowing Caddy
to retire them first. The entry point uses the tested server factory. Request
and header deadlines retain Node defaults. No action retries were added, no
authentication gates changed, and no WebSocket timers were relaxed.

A real TCP regression test sends two POST requests over one connection beyond
the previous idle deadline and checks the advertised lifetime exceeds the
proxy pool. This change deploys through the normal engine maintenance flow.

References: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
and https://nodejs.org/docs/latest-v22.x/api/http.html#serverkeepalivetimeout
