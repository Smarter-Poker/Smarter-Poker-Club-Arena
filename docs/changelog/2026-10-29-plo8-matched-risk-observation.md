# PLO8 matched-risk observation admission

The host sanitizer now accepts the closed PLO8 variant in version4 matched-risk observations, matching the separately qualified engine helper domain. Previously it rejected a valid PLO8 observation after the original record and hand-binding checks succeeded.

The existing actual Python boundary regression now verifies PLO8 roundtrip and rejects unsupported PLO7/PLO9/fixed-limit Omaha/private variant labels. Source, hash, full-hand, intended-execution, geometry, privacy and unknown-evidence checks remain required. This control change does not prove an original PLO8 helper invocation, causal strategy quality or live fleet coverage.
