# Qualification CLI regression runtime imports

The child-process regression now imports the qualification CLI and equity governor through their `.js` runtime specifiers. The existing `node --import tsx` loader resolves those specifiers to the TypeScript sources during this test. This preserves the server-wide ESM extension guard and the actual child-process assertions that the governor is disabled and an absent locked plan produces no output. No qualification plan, strategy or production setting changes.
