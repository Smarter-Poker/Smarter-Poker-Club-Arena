# A table cleanup error does not restart the fleet

At 17:28:38 UTC production restarted outside the announced maintenance break. The triggering table had already released its process-global engine ownership, but its final settlement diagnostic made `ServerTableEngine.stop()` reject. `TournamentManager.stop()` started every table stop, retained those raw promises, and did not attach `Promise.allSettled` until after it had awaited scheduler and lifecycle drains. Node correctly reported the temporarily unowned rejection; the process-wide fatal handler then shut down the entire engine. The later `PromiseRejectionHandledWarning` was proof that the intended owner arrived too late.

Tournament-manager teardown now attaches both fulfillment and rejection handlers in the same turn that each table stop begins. Each handler resolves to an explicit outcome object. The manager still retains the exact failure and applies the existing ownership rule: a cleanup failure after process ownership was released is reported and the engine is retired, while an earlier failure remains fatal to that manager's ownership certificate. There is no swallowed error, retry timer, watchdog exception, or delayed reconciliation.

The regression law pins the immediate outcome attachment and forbids restoring the raw-promise collection that caused the production restart.
