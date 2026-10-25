# Resolved rebuys do not retain a stalled-bust clock

The elimination stage returned early after every captured bust rebought, or after a locked decision read proved concurrent rebuys/open windows, without settling its old bust-wait clock. The existing 120-second liveness check could consequently request a successor manager even though those busts had resolved or were legitimately waiting for their database-owned deadline.

Clear the clock for resolved captured busts, retain a fresh clock for an untouched batch or proved future decision window, and retain the original age for unreadable/refused decisions and missing, malformed or expired open-window deadlines. Financial writes, player treatment, rebuy deadlines and the existing recovery/silence bounds are unchanged.

The regression runs the actual elimination stage: two benign paths fail before the repair. Eight cases cover successful/concurrent rebuys, batching, valid windows and unresolved controls; existing successor-drain and rebuy guards remain required. This source repair is not itself evidence of the exact production incident trigger or installation. Record the incident attribution, protected candidate checks, selected runtime release and stable-build live proof in the task checkpoint before claiming completion.
