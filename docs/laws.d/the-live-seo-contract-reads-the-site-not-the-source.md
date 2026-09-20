# tests/the-live-seo-contract-reads-the-site-not-the-source.law.test.ts

After every Club Arena publish, post-deploy-e2e.yml reads production the way
Googlebot does and holds it to the SEO contract the bundle itself declares:
build-info serves the published SHA, every route in the prerender manifest
serves 200 with its title, an indexable robots meta, its exact canonical, a
parseable JSON-LD document and real words, the sitemap names exactly those
routes and every URL in it answers 200, and the shell behind a deep link still
carries the static head. No route list lives in the workflow; the check is
independent of the engine certificate so an engine release lagging main cannot
hide a broken head.
