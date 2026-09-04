# No source map survives a publish, and a build with no version says so

Date: 2026-09-04
Branch: `fix/no-map-survives-a-publish`
Follows: `docs/changelog/2026-09-04-push-to-live-under-six-minutes.md`

## The half that was still broken

The Sentry fix in #2942 moved the upload to the publisher, aligned the release
name to the shipping sha, and made the publisher strip every `.map` from
`dist/` before the rsync. That stops NEW maps reaching players.

It does nothing about the ones already there. `/assets/*` and `/fonts/*` are
served from an **additive pool** the publisher never `--delete`s, pruned by
**age at 30 days**. Every map published before the fix keeps being served for
up to a month. Verified against production while writing this:

```
$ curl -sI https://smarter.poker/hub/club-arena/assets/index-D_zJpMrI-v6.js.map
HTTP/2 200
```

267 files, 27MB of readable source, per deploy, going back weeks.

## Why deleting these from the pool is safe when deleting anything else is not

The pool exists because **a player whose tab still holds the previous
`index.html` asks for the previous hashed chunks mid-hand.** Removing a chunk
that is "not in the current bundle" is exactly the 404 the pool was built to
prevent, and CLAUDE.md says so in as many words.

A `.map` is not in that category and the difference is categorical, not a
judgement call: **nothing a running application loads is a source map.** A map
is fetched by devtools, and only when a human has them open. No mid-hand
request, no service worker precache entry, no `<script>` tag, no dynamic
import can reference one. So the pool sweep is one line, targeted by name, and
it cannot 404 anything.

It is idempotent and self-limiting: once the pool is clean, `find` matches
nothing and the step costs one traversal per publish. It reports the count it
removed, so the first run says how big the backlog actually was.

## And a smaller thing that hid the same class of failure

`src/core/SentryInit.ts` tagged every event
`club-arena@${VITE_APP_VERSION || '1.0.0'}`.

A build with no `VITE_APP_VERSION` has no maps uploaded for it and never will -
that is a broken publish, not version one. Reporting `1.0.0` made it
indistinguishable from a real release in the Sentry release list, so the single
observable symptom of a misconfigured publish looked like ordinary traffic. The
fallback says `unknown` now. The publisher always sets the sha, so in
production this never fires; it fires exactly when something is wrong, which is
the point.

(`src/hooks/useSystemHealth.ts` has the same `|| '1.0.0'` for its health
panel's version field. Left alone deliberately - it is a display value on a
health page, not a symbolication key, and changing it belongs with whoever owns
that panel.)

## Pinned

`tests/source-maps-go-to-sentry-not-to-players.law.test.ts` grows two cases:
the pool sweep must exist in the publisher, and the runtime release must fall
back to `unknown` rather than a plausible version number.
