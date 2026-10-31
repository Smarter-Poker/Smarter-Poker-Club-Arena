# Qualification retains the transferred repository identity

The isolated component qualifier used the former repository namespace while
its provider reader deliberately refuses redirects. A real request in the
canonical transferred repository would fail even after fixture provisioning.

Read-only provider metadata on October31 confirms canonical full name
`Smarter-Software-PIQ/Smarter-Poker-Club-Arena` and stable numeric repository
ID `1132369872`; the former name resolves to that same repository. The native
qualifier now requires the request, actual GitHub job context and provider
metadata to agree on the exact canonical name and original numeric identity.
It accepts no alias, arbitrary repository or replacement at the same name.
The existing no-redirect artifact/provenance checks remain enforced.

The focused Python identity guard is exercised through the existing maintained
representative Node test glob. The repository-binding correction changes no fixture runtime, production
feature, grant, journal, publisher or workflow installation. The absent draft
controller adapter retains its old binding and is still a separate provisioning
prerequisite; it is neither edited nor installed here. Full-schema connected UI
qualification remains unexecuted until its actual admitted inputs/executor exist.

- File: `operations/release/native/qualify-components.py`, before lines25,82,304.
- Before: former namespace and request/context string equality only.
- After: canonical namespace plus original numeric identity matched to actual provider metadata.
- Verified: source reread; accepted exact identity and eight negative bindings checked.
- TypeScript: PASS (`tsc --noEmit`) on the integrated candidate.
