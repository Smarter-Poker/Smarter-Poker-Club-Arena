# Retention discovery advances within its existing budget

Repeated live cold-page timeouts showed the existing 5000-row statement could roll back discovery progress. The same function now processes 250 raw keys per chunk, retaining a maximum of 5000 per invocation and a 900ms budget. Completed chunks update the cursor atomically with queued rows. It avoids starting a chunk when the remaining budget cannot cover the longest observed chunk. The existing job, two-second statement bound, freeze/lock barriers and financial records are unchanged.
