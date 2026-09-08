# Pizza Payload

Replace the legacy pizza landing with a face-down slice that slides, leaves a cheese smear, stretches a tether, peels away at 2200 ms and drops out, leaving pepperoni on the forehead. The actual avatar and chip state are never modified. All motion is finite, scales with animation speed, and reduces to static residue under reduced motion.

The new generated atlas has real RGBA transparency. Two earlier checkerboard outputs were rejected. The existing packaged wet impact cue plays; bespoke cheese and peel sound recordings remain pending. Initial validation: 32 specification, artwork and darkroom tests; 11 browser captures; 15 normalized-speed samples; zero active reduced-motion animations and page errors.

Previous premium release PR #3673 merged as c864fbe1acf170bbf2ad34d5022267223356e699 and published via Hetzner run 34186369801. Both origin and public URL served that SHA; 181 artwork files per origin, 362 requests total, matched repository bytes. Pizza is a subsequent change and is not included in that release.
