# Tournament qualification child source loading

The real Linux child test ran outside Vitest without a TypeScript module loader, so its first `.js` source import failed before the development pair could run. Register the existing tsx loader explicitly in that test and restore the parent arguments after shutdown. Production compiled JavaScript, the default Linux launcher, priority verification, and the actual one-pair assertions are unchanged.

Validation: focused local tests and TypeScript compilation; the real Linux child remains a required hosted check because the local host is macOS.
