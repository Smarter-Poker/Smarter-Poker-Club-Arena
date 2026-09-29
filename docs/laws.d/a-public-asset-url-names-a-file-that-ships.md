# tests/a-public-asset-url-names-a-file-that-ships.law.test.ts

Every literal url('/...'), mediaUrl('...') and src/href/srcSet="/..." under
src/ must name a file that exists in public/. Vite rewrites a root-absolute
url() to the arena base only when the file exists, so a stale name ships
unrewritten and the browser asks the World Hub root for it: #4704 renamed
wallet-row-shell.webp to its sealed name and three stylesheets kept the old
one, 228 requests in three days for a 404 and a VIP plate and Marketplace
rows without their shell.
