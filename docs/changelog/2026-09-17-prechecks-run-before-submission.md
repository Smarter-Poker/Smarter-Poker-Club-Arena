# Prechecks run before submission

PR4788's validation exposed three avoidable rejection paths. The Mac hook
allowed incomplete local dependencies to defer tests to GitHub; its source-read
selector ignored changed documents/workflows/scripts; and the cash qualification
manifest still pinned the previous CI workflow. The omitted document contract
failed on the playbook's hamburger wording. Preserve its exact existing assertion
and restore the explicit rule/reference in prose.

The maintained pre-push hook now refuses missing applicable compiler/test tools
and incomplete or mismatched locked direct dependencies in the owned checkout.
It selects changed tests, imported source and contracts reading every changed
path, including removed paths, plus affected Node tests and the existing cash
input-manifest unit checks. It requires the submitted HEAD and clean tracked
files, accumulates all pushed ref inputs, compiles affected engine sources in the
server package, and never probes/repairs another clone's dependencies. It no
longer recommends skipping a failing test. Workspace preparation remains free
of automatic Mac dependency copies or installs; the latest owner policy permits
explicit private locked dependencies on the mounted task-owned SSD.

A separate race rejected completed PR builds whenever main advanced while they
queued. A GitHub pull_request validation build now proves its event repository,
open PR, merge ref, full checkout SHA, exact two parents and main-base ancestry.
It records an explicitly validation-only artifact. This does not change actual
production build freshness. Both maintained publisher admission implementations
refuse validation-only artifacts; ordinary push/dispatch/strict builds still
refuse stale source and incomplete history.

Validation: the existing hamburger law failed before/passed after; the executed
hook selector fixtures failed nine cases before/passed all after. Dependency
fixtures cover missing, malformed, changed-version and stale-lock cases without
modifying shared links. The provenance suite exercises real isolated Git merges
and both actual publisher admission programs with invalid identities and
nonpublishable artifacts. Exact GitHub run35270377770 merge-parent evidence
matches the event shape. The cash manifest's only stale input was ci.yml; its
full byte/hash pin is refreshed and all six input/outcome tests pass. The native
cash financial/scheduler implementation and required hosted execution are
unchanged. These local results do not certify protected merge or live delivery.
