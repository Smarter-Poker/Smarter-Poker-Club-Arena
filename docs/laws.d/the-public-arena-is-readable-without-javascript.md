# tests/the-public-arena-is-readable-without-javascript.law.test.ts

The origin serves one index.html whose body is an empty #root, so every word
of every page existed only after the bundle ran. Googlebot renders
JavaScript; the crawlers that decide what ChatGPT, Claude, Perplexity and
Meta AI can cite do not. scripts/prerender-public-routes.mjs now renders the
indexable routes (landing, Help Center, the four legal documents) to static
HTML at the end of build:ci, and fails the build if a page comes out empty,
noindex or without its canonical. This law pins the build order, that the
prerender entry covers exactly the indexable routes with every exception
written down, the document composition, and that the Help Center keeps every
answer in the DOM and renders them from one shared source.
