# Wheel artwork can recover after a failed load

The daily report contained 64 wheel-card artwork errors. The image and painted
texture caches retained rejected promises, so a single transient image or canvas
failure made every later mount in the same tab reuse the failure indefinitely.

Failed promises now retire only their own current cache entry. The original
request still reports the failure and retains the existing approved SVG artwork
fallback. A later normal mount can load and paint again; successful images and
textures remain shared and cached. No timer, retry loop, artwork, prize, spin or
payment behavior changes.

Mounted-component regressions cover an image failure, a renderer failure, a
successful later mount, and reuse of that successful result without another
image load.
