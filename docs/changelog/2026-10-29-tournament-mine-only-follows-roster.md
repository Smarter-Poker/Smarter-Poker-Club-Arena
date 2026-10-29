# Tournament Mine Only follows the complete roster downline

Ranking and Entries now resolve your players through the existing authorized roster downline reader, which follows club membership assignments recursively. The separate agents parent graph can disagree with those assignments and omitted nested agents and their players. No hierarchy or financial records are changed.

The hook requests only user IDs, exhausts ordered pages, preserves its role gate, excludes the viewer from downline badges, and rejects partial or malformed results. Switching club/viewer clears stale results and ignores late responses. Focused hook regressions cover nested players, pagination, authorization refusal and stale responses. Field rankings, artwork and the viewer's own highlight are unchanged.
