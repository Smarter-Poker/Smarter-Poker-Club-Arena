# Diamond Checkout Package Rows

The Add Diamonds catalog grid compressed its implicit rows to fit the available
scroll viewport while package artwork kept its native aspect ratio. At desktop
1280 by 900, 224px packages occupied 139px tracks and the next row covered the
previous purchase controls. The same cause reproduced at375,393 and landscape.

Rows now retain their max-content height and start alignment; the existing
catalog scrollport exposes all eight packages without frame overlap. Short
landscape viewports scroll the full native chassis instead of constraining the
catalog to less than one purchase control. The body underfill outside the
image's transparent rail margins is transparent; the approved slice interiors
and package/control artwork remain intact.

Actual component renders use the public server catalog and real global CSS and
fonts. Original rows overlap at all four sizes; corrected rows do not, retain
native ratios and preserve44px purchase hit areas. Existing maintained visual
contracts pin the row owner, landscape scroll and exterior fill. Prices, offers,
account ownership and purchase handlers are unchanged. No checkout was begun.
