# Retain the client for reviewed backend tools

Backend-only accounting qualification and Lightning pilot tooling changes were
classified as conservative client build inputs. That forced new static releases
while long hosted browser checks were running, superseding their exact-release
certificates despite unchanged client inputs.

Classify only the reviewed tool paths as separate backend components. Actual
Rollup module inputs and watched directories still override every exclusion.
Unknown tools and newly added server modules remain conservative. Existing
inventories stay immutable; the next normal publication creates a fresh baseline.

The maintained runtime-retention test uses real Git trees and Vite build graphs
to prove backend-only changes retain a runtime, imported or watched backend tools
require publication, and unknown paths remain refused. CI already runs this suite.
