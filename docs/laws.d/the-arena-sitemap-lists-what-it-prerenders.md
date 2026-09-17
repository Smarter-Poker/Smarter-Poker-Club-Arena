# tests/the-arena-sitemap-lists-what-it-prerenders.law.test.ts

The arena publishes its own sitemap at /hub/club-arena/sitemap.xml, generated
from the prerender manifest, so it can only name a page a crawler without
JavaScript can read, and every lastmod is the newest commit touching that
page's source rather than the build date. The World Hub's hand-typed list of
arena URLs is retired; two repositories no longer keep one list.
