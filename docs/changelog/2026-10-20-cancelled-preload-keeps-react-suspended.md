# Cancelled preloads keep React suspended

A cancelled Vite preload error resolves the import to undefined while the existing stale-document recovery navigates. Returning that value from lazyWithRetry crashed React's lazy initializer on Club Home. The lazy factory now keeps that cancelled load suspended while recovery owns it, and rejects a missing default export explicitly otherwise. Existing reload limits and non-chunk error visibility remain in force.

The regression exercises the Vite event cancellation and undefined import result. Four new assertions failed before the fix; all 14 chunk/lazy tests passed afterward. Client TypeScript compilation passed. Production publication and live verification are recorded separately in the task checkpoint.
