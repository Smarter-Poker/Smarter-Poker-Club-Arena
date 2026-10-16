# Cashier Max Preset Certification

The Advanced Cashier browser certificate read the CSS-uppercase `MAX` command through `innerText` but excluded only the source spelling `Max`. It incorrectly applied the numeric chip-amount oracle to that command.

Classify only the case-insensitive exact Max label as a command, require exactly one such command, and retain numeric compact validation plus the independently specified four numeric presets. Missing, duplicate, malformed and unknown controls still fail. Product code, wallet precision, amount handlers, artwork and the Club Bank Transaction Ledger are unchanged.

The focused regression reproduces uppercase `MAX` failing the previous classification and passes after the correction. Existing real amount-rail, wallet, accessibility and handler coverage remains in the production certificate.
