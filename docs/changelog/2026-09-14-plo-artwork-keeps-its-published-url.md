# PLO artwork keeps its published URL

The September 14 PLO card correction replaced the bytes behind an existing permanent asset URL. The static origin correctly rejected that publication because older tabs still depend on those bytes.

The corrected artwork now uses `chassis-b0b05b302c99.png`. Both the rendered PLO card and the mobile card registry request that URL. The original `chassis.png` is restored from the last served source, and the replacement image is retained byte-for-byte. Card geometry, labels, actions, and artwork are unchanged.

Validation: the two asset identities and actual rendered URL have regression coverage. Three assertions failed against the previous source; all nine card tests pass after the repair. Running the production media optimizer on the restored source reproduces the live original asset's SHA-256, `9411a09e2a61040170b87300652239013677ffe75ec26f77d110d235372e8eb3`. The replacement URL was confirmed unused before publication. The origin's immutable pool check remains unchanged.
