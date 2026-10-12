# Closing certification refreshes protected history

The completed production browser run37562538452 tested f681, then refused the protected successor8d39 because that newer commit was absent from its original checkout. Its closing classifier reported a lineage defect before it could inspect the new history.

Both client and live-table closing checks now fetch only the existing origin main before applying the unchanged strict classifier. A forward publication remains superseded and cannot certify a release; rollback, unrelated or unresolvable revisions still fail. An unreadable protected history is explicitly unknown, with certified=false. No publisher, release scheduler, engine restart, financial request or certificate bypass is added.

Real isolated Git regressions reproduce the missing-future-commit refusal before the correction and exercise forward publication, rollback, unpublished revision and fetch failure in both maintained workflow blocks. Existing exact-case coverage, account cleanup, classifier and seal guards remain unchanged.
