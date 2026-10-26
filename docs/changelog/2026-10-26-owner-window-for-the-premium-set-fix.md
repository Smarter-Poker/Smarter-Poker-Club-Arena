# Owner window for the premium set fix

#8166 (a premium pocket pair that makes a set under a higher board card counts
as a made hand, so the hold'em premium rule keeps it betting) merged at 12:33
UTC as c2a5cd44b. The rest of the premium rule is already serving in 4dfd07ef.
Under Dan's order to finish the horse premium fixes and publish them now, not
at 4am, one owner window names c2a5cd44b. It uses the existing last-hand
notice, hand-boundary drain, database freeze, certificate, rollback reserve and
thaw, respects the seal's one-window-per-hour limit, carries no migrations and
ends once the containing engine is serving.
