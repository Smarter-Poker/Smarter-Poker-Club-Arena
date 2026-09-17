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

It also pins that the web fonts are declared once. The self-hosted fonts
stylesheet is inlined into the prerendered head in place of its async link,
and no stylesheet under src re-imports the same faces from Google Fonts: a
later declaration wins the cascade, and every word swapped to a fallback and
back while it loaded (measured CLS 0.12 on the arena root, 2026-09-17).
