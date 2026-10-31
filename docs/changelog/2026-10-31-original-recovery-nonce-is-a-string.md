# Original recovery nonce is a string

The service-authorized original-twenty recovery handler allowed a JSON array
containing one UUID through regular-expression coercion. It could pass a
non-string nonce to the runtime owner, whose later identity comparison expects
a string. The handler now requires the string type before UUID validation for
both preparation and readback. Valid UUID-string requests retain their existing
behavior and authority checks.

Two focused regressions fail on the previous handler and pass after the fix.
They verify that malformed requests never reach either runtime operation.
This source correction does not prepare, recover, settle or restart any live
tournament. Protected integration, containing engine publication and affected
live verification remain separate delivery steps.
