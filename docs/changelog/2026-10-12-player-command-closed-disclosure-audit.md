# Player Command Closed Disclosure Audit

## Cause And Repair

The broader production chrome audit in run 38206133852 reported 74px of footer coverage for Wallets And Fees Are In Club Chips on the Players route. The native Metric Definitions disclosure was closed. Chromium retains nonzero child layout rectangles while the disclosure body is not painted, and its computed display/visibility remain block/visible; the old leaf classifier mistook that hidden geometry for readable content.

The authoritative existing chrome audit now excludes descendants of a closed details body while retaining its summary. The ancestor selector also handles nested disclosures. Open definitions remain subject to all original top/bottom bounds, clipping, scroll-boundary and strict-empty assertions. No page runtime, styling, data, permission or release path changes.

## Actual Published Verification

The original production failure is retained in the task archive. Native published Players inspection confirmed seven paragraph rectangles under a closed disclosure, absent from its accessibility tree. The repaired classification excludes exactly those seven, retains both Columns and Metric Definitions summaries, and includes all seven paragraphs after the real Metric Definitions control opens. The earlier corrected six production Players cases passed without skips or retries; their source and all page runtime bytes are unchanged by this classifier repair.

Required source checks, normal hooks, protected merge and maintained publisher delivery remain owned by this task. Test-account cleanup from the six-case run completed and verified absence at 05:48:30 UTC. Separate notification, Lightning and club-home thumb-control failures are outside this phase and are not presented as passing.

Five retained DOM and source-binding checks cover closed bodies, visible summary labels, open bodies, nested open disclosures inside closed parents, and nested closed summaries inside open parents. The tested selector is supplied as a serializable argument to the actual production page probe. All 35 connected checks pass, and all 13 existing chrome-audit cases compile.
