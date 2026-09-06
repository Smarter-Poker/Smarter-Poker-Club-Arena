# tests/a-card-says-what-it-is.law.test.ts

Every playing card announces its full name ("Ace Of Spades", never "A Of
spades") through the one `cardWords` helper, a face-down card says it is face
down rather than being silent, and nothing is read out twice - the broken-image
glyph and the felt's individually-labelled cards are hidden when a label above
them already says the same words.
