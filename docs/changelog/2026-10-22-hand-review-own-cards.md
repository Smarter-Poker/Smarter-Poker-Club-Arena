# Hand Review Keeps Your Hand Visible

A player outside showdown disappeared from the Summary whenever their private cards were missing. The table can receive a saved hand before its private facts projection, and that incomplete record could remain cached for five minutes. The reported tournament hand retained two-card facts for all nine participants, written 368 ms after its public hand row.

The selected hand now resolves missing viewer details on open or selection through the existing authenticated hand reader. Both tabs and Replay use the resulting single model. The viewer has a clearly identified card and result row before the rundown; unavailable and failed private reads retain that row and expose an explicit refresh. Existing showdown rows and pot accounting remain authoritative. No polling, engine replacement, schema changes or hidden opponent-card exposure.

Private lookups reject a response if the account changed during the request. Component and service regressions cover missing cards, successful late facts, failed reads, explicit refresh, selection changes, existing cards and ownership. Cards that were never retained remain honestly unavailable; no hand or financial records are changed.
