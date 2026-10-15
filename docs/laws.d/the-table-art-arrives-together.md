# tests/the-table-art-arrives-together.law.test.ts

The live table never shows seats on a bare gradient (Dan 2026-10-15): the service worker answers a failed image fetch with a real network error instead of an empty 200, useTableArt preloads, decodes and retries the felt and room rasters with a fresh URL, and TablePage paints only decoded URLs behind a cover that lifts once both are ready.
