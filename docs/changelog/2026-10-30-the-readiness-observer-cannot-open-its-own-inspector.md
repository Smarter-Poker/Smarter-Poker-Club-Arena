# The readiness observer cannot open its own inspector

The recovery transaction's TCP readiness child inherited the container's
`NODE_OPTIONS`. An isolated real Node 22 reproduction with `--inspect` opened
the observer's own listener and returned the same refusal as a genuine existing
listener. An inherited `--require` also executed before the read-only probe.
The production container's actual startup options and historical refusal's
subcause remain unknown; this reproduction does not establish either.

The readiness and checkpoint transport docker-exec children now remove only
their own `NODE_OPTIONS` and `NODE_PATH` and explicitly disable inspection.
The checkpoint's existing inspect/debug option refusal now also runs in the
readiness child shell before Node or any announcement. The initial runtime
validator retains that same refusal before launching neutral Node. Its version,
main command-line and source checks remain unchanged. The main process environment,
fixed loopback target, three-second outer budget, one-second socket budget,
positive ECONNREFUSED requirement and all announcement/cutover safeguards stay
intact. Startup isolation adds no inspector action. The readiness probe remains
TCP-only; the existing guarded checkpoint protocol is unchanged.

The engine test suite executes the actual maintained shell helper with
real Node, TCP sockets and GNU timeout; only docker-exec transport is substituted.
Nine cases cover positive absence, inherited inspection, inherited preload, a genuine
listener receiving no payload, a failed child transport, the preserved initial
configuration refusal, allowed initial options, and neutral stdin transport.
Synthetic child payloads qualify startup and unchanged authentication/arguments;
they do not invoke the production inspector or custody operations. The real recovery
request fixture retains its exact command assertion with the isolated arguments.
