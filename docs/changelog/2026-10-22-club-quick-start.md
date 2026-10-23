# Club Creation: Defaults And Send Link

Owners can create without entering a name or choosing a crest, description, visibility or approval settings. Those controls live behind optional customization. The account-scoped creation intent is saved before submission, including an automatically generated name and stable request ID.

After creation the client completes standard opening setup through the existing atomic owner-only RPC: house rake, a default tag line, welcome-funded reserves reused, no new promotion or prize allocations. Existing setup wins on retries. A database capability read refuses automatic setup until the reserve-reuse prerequisite is installed. A setup failure is reported separately from the already-created club.

Both creation entry points open the owner's attributed short invite link. Send Link uses native/system sharing, with clipboard fallback. The compact result keeps customization and referral statistics out of that first action. The older lobby checklist is available under Customize Club (Optional). Owners recovering incomplete setup get Use Defaults or optional detailed configuration.

The first-club welcome package retains its existing lifetime eligibility. Diamond Spins wallet acceptance stays explicit. This change does not grant another funded package to repeat owners.

Connected source inspection and live function readback found that the October 21 rake migration had replaced the October 1 welcome-reuse guard. The new asserted function-only migration restores that guard while retaining current rake bounds and financial permissions. Isolated PostgreSQL reproduced a second 300-chip debit before the repair and proves no additional debit afterward, zero new funding rows, idempotent replay, ownership checks, receipt mismatch refusal and authenticated-only capability access. The existing required accounting job runs this regression.

Client tests cover no-typing creation, optional controls, retry identity, defaults, capability failure, native/web link sharing and explicit link retries. Production certification checks the opening receipt, unchanged 99.7K bank, generated short link and reachable Send Link action.
