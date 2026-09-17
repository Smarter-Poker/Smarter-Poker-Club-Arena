# Diamond Game Validation During Concurrent Publication

PR4779 repeatedly completed compilation but its browser checks could not start when unrelated protected merges advanced main during the build. CI35271141786 records a one-commit advance. The defect was reproduced locally.

Protected PR4727 independently landed the maintained correction during this delivery. This branch adopts that implementation and its six executable provenance and publisher tests, retaining the stricter repository/workflow/source identity and explicit validationOnly marker. The temporary equivalent implementation and duplicate assertions from this branch were removed during integration. Both publisher predicates refuse validation artifacts; protected production freshness remains unchanged.

The merged CI workflow retains the Diamond playfield browser checks and accounting fixtures alongside the newer accounting work. Only its two reviewed qualification pins are recomputed for the composed inputs.
