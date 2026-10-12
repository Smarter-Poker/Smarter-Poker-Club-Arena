# 2026-10-04 - production browser runs read the arena's static files from the origin

## What was wrong

Vercel reported the World Hub's on-demand spend budget at 100% four days into
the billing cycle. The owner expected the platform to cost close to nothing
there.

Read from the provider, not assumed:

- hub-vanguard served about 2.0M requests in 24 hours. 97% were under
  `/hub/club-arena/*`, and 1,990,915 of them ran the Hub's edge middleware.
- One billed day (2026-10-02 07:00Z to 10-03 07:00Z) was $7.47: CDN requests
  $4.24, function invocations $1.12, function CPU and memory about $1.16.
- The traffic ran flat at about 130,000 requests an hour from 13:00 UTC to
  about 03:00 UTC and was absent from 03:00 to 13:00 UTC.
- Supabase's edge logs for the same windows show the client: Playwright's
  bundled Chromium 145.0.7632.6 and WebKit device profiles, from Microsoft
  (GitHub-hosted runner) addresses. 15k-79k requests an hour in every active
  hour, zero rows in the silent window.
- `Post-Deploy E2E` runs after every `Publish Club Arena`, takes 20-24 minutes,
  and serialises. With a publish landing every few minutes while agents merge,
  one run was effectively always in flight.

Every Playwright test gets a fresh browser context, so every test is a cold
load of 80-125 static files, each one travelling
smarter.poker -> Vercel -> ca-static.smarter.poker and billed on the way.

The verification was doing its job. The cost was in the route its static files
took.

## What changed

`tests/e2e/support/staticOriginDirect.ts`, installed from `playwright.config.ts`.

When a run targets `https://smarter.poker/hub/club-arena/`, every Chromium
context answers a Club Arena static-file request by reading the same file from
`https://ca-static.smarter.poker` and handing it to the page. The page still
sees the smarter.poker URL, same-origin, with the bytes Vercel would have
proxied.

Still on the public path, on purpose: the document and every client route,
`sw-bus.js`, `build-info.json` and every other `.json`, every API call, and
video. `tests/e2e/support/staticOriginPath.ts` is the whole decision and
`tests/unit/staticOriginPath.test.ts` pins both edges of it.

It cannot fail a test. If the origin cannot be read, answers 5xx or a
redirect, or the page closed mid-request, the request falls back to the public
path as before.

Local and preview targets are untouched. `CA_E2E_STATIC_VIA_PUBLIC_PATH=1`
turns it off for one run.

## What still proves the rewrite serves static files

- The WebKit projects are not patched (WebKit does not expose service-worker
  requests to routing), so every Post-Deploy run still loads the arena's
  static files through smarter.poker in WebKit.
- `.github/scripts/origin-contract.sh` reads a hashed asset through
  smarter.poker every hour from `production-integrity-audit.yml`.

## How it was verified before merge

The container this was written in cannot reach production, so the installer
was run end to end against local stand-ins: one HTTPS server answering as both
hosts by name, with a page that loads a module script, a stylesheet, images,
a sound over `fetch`, registers a service worker that precaches, and lazy
imports a chunk.

|                     | public path                                            | origin                                                     |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| before (detour off) | document, build-info, sw-bus.js, and every static file | nothing                                                    |
| after (detour on)   | document, build-info, sw-bus.js                        | every static file, including the service worker's precache |

The page booted identically in both, saw only smarter.poker URLs, a 502 from
the origin fell back to the public path, a missing chunk was still a 404, and a
context built with `browser.newContext()` was covered.

## Not done here, and why

Loading static files from the origin for real players (a Vite asset base plus
CORS on the origin) was assessed and not attempted. It needs a Caddy config
change on the origin host, and `infra/ca-origin/README.md` and
`tests/unit/originConfigDeployment.test.ts` are explicit that no deploy path
for that file exists. A missed CORS header there is a white screen for every
player. Real player traffic is a small share of the bill; the runs above were
nearly all of it.

The World Hub side of the same incident (static arena files no longer invoke
the edge middleware) is World Hub PR #2106.
