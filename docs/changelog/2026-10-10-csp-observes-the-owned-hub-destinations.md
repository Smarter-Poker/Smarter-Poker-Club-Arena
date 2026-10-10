# CSP observation follows the current World Hub destinations

The strict production CSP observer correctly refused a 404 document at
`/diamonds` in run38041665880. The old `/games` target also returns404. Neither
exists in the World Hub page inventory. Maintained Diamonds and Games navigation
points to `/hub/diamond-store` and `/hub/home-games`, whose owned pages and live
Next route identities return200. The test now visits those actual destinations.

Five Arena routes and three Hub routes remain required. One successful HTML
document, visible nonempty application root, fallback refusal, both original
observation windows, scroll/collector failure propagation, the240-second budget
and zero-violation assertion remain unchanged. The source regression fails with
the stale inventory and passes after correction. The three actual customization
journeys and their normal durable3afe/f8 seal retain separate passing evidence;
the failed broad CSP/client run is not relabeled successful.

This is verification-source repair only. No runtime implementation, engine, SQL,
CSP header or production policy is changed. The normal source-bound retained
runtime route qualifies the current test source against the already serving
client; final actual CSP acceptance still requires its owning browser verdict.
