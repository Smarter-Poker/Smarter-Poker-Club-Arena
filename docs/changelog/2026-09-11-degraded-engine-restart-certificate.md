# A Degraded Engine Still Shows Its Restart Certificate

The maintenance wait and the final locked host recheck used curl's HTTP-failure
mode when reading `/health`. A failed equity worker makes this endpoint return
503 even when the engine has parked every table and issued a complete durable
restart certificate. Both readers discarded that certificate, so the normal
release path could not replace the degraded process.

Both certificate readers now retain the body only after a complete HTTP
transfer with status 200 or 503. Other statuses and failed transfers are
rejected. The existing active countdown, durable confirmation, zero unparked
tables, readiness flag, and minimum 180-second grace checks remain in place.
The final check still requires a running engine and executes under the host
mutation lock before the one-use sealed release starts. New-build health and
version verification still require their existing successful responses.

The regression suite executes the actual curl readers and Python validators
from both workflow steps against a local HTTP server. Before the repair,
23 cases passed and both valid-503 cases failed. After the repair all 25 pass,
including incomplete certificates, malformed JSON, other HTTP errors, a
truncated transfer containing otherwise valid JSON, and a stopped engine.
The five covering deployment and sealed-release suites pass all 100 tests.

This change repairs reading restart authority. It neither changes the equity
worker's failure policy nor certifies a production cutover. Production release
and programme acceptance require their own live evidence.
