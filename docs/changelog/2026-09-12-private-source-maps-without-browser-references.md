# Keep source maps for Sentry without shipping broken browser references

PR4346 at53382a6df5268d54e25af2b8099072910b075cfc compiled successfully, but CI34669855359 measured2601kB gzip against the unchanged2600kB whole-app limit. Initial load was304kB gzip against320kB. The publisher uploads source maps and deletes them; every emitted JavaScript chunk still carried a sourceMappingURL to its subsequently removed map.

The web build now uses Vite's hidden source maps. It still generates the adjacent map with original source and mappings for Sentry; the browser script omits the unusable reference. Native builds still emit no maps. No feature, tracing/replay integration, vendor version, chunk allocation, size limit or upload/cleanup policy changed. The installed Sentry bundler plugin resolves an adjacent `<chunk>.map` when no sourceMappingURL exists.

The executable Vite tests build a small real bundle with the repository config: the adjacent web map retains source and mappings; hidden and linked executable output differ only by the map-reference comment; the output still executes; native output has no map. Existing upload identity and build-concurrency tests remain applicable. The full app build and exact size measurement belong to CI; no Mac dependency installation is used.

References: [Vite build.sourcemap](https://vite.dev/config/build-options#build-sourcemap), [Sentry's private source map guidance](https://www.sentry.help/en/articles/13965157-javascript-do-i-need-my-source-maps-publicly-available).
