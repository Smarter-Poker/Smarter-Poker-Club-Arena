# Owner window for the short-stack jam receipt fix

#8183 (the policy receipt check admits the V58 short-stack jam, so a short
big blind's jam heads-up against the opener is played instead of being folded
by the liveness fallback) merged at 14:32 UTC as ca8430859. The engine serving
since 14:18 UTC (dbc2f328d) does not contain it. Under Dan's order to have
every horse upgrade activated in all 1,000 horses, one owner window names
ca8430859. It is placed first in the list because the stage reads the first
time-valid entry, and the premium-set window below it is time-valid until 18:30
UTC but already served. notBefore is 15:20 UTC, one hour after the previous
owner window served, so the seal's one-window-per-hour limit holds. It uses the
existing last-hand notice, hand-boundary drain, database freeze, certificate,
rollback reserve and thaw, carries no migrations and ends once the containing
engine is serving.
