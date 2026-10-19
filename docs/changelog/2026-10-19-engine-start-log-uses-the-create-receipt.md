# The launch log uses Docker's existing container receipt

The 20:55 engine cutover (release 39319175828) printed the candidate container
ID, then exhausted its bounded launch budget before the startup log appeared.
The safe rollback restored the previous sealed engine. The log ordering points
to the redundant `docker inspect` after `docker run`; the retained output does
not establish why that daemon read stalled.

`engine-up.sh` now retains the ID returned by the successful `docker run -d`
and uses it for the startup log. It preserves Docker's exit status and stdout.
The release transaction's independent container ID, start-generation, local
and public health, elected database leader and sealed-result proofs remain
unchanged. No cutover budget, rollback reserve or maintenance rule changes.

The existing executable outgoing-log regression now models a three-second
post-start inspection stall. It fails before this change (3,478 ms versus the
existing 2,000 ms launch bound), and must pass with the real launch script
returning while both retained logs are safely archived. The test waits for its
background fixture cleanup before asserting timing so cleanup cannot mask a
real regression. Production adoption and the full live release proof remain
required; isolated reproduction does not certify a future cutover.
