# Smaller header photo delivery

The live Club Arena header fetched a 1179-by-1509 public JPEG for a roughly 55-pixel portrait. It now uses the existing public image transformation helper with a 128-pixel retina image. The maintained CSS bounds the slot below 57 CSS pixels on desktop and 45 on mobile. Artwork, the black mask, hairline frame, crop and navigation remain unchanged.

JPEG transformation failure falls back to the original photo, then the existing default. Repeated default failure does not reassign its URL. Animated-capable, library, external, signed and data URLs retain their existing behavior. Actual component regressions reproduce the old full-size request and cover fallback, replacement and preserved formats; the existing header geometry and navigation checks remain enforced.

This reduces this image response, not a measured percentage of the total Supabase bill. Image transformation origins have their own billing meter.
