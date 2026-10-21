# Create A Club Custom Logo

The creation form now displays the processed custom logo before submission. Previously the selected image was stored in form state and sent through the custom upload contract, but the crest vault never rendered it. Processing failures remain visible beside the picker, retain the previous valid logo, and allow the same file to be selected again. Delayed decoding cannot overwrite a newer preset or another account's form.

Image optimization falls back to the browser's ordinary image decoder when bitmap decoding is unavailable or rejects an otherwise valid image. Both paths retain the existing 5MB source limit, 512px crop, 2MB output ceiling, and atomic club creation contract.

Regression coverage includes visible preview and submitted custom payload, persistent errors and retry, delayed selection ordering, missing/rejected bitmap support, and invalid-image resource cleanup. The supplied 1254px PNG (2543426 bytes) processed successfully in Chromium before the repair, confirming the missing-preview defect independently of storage. Source-level failures were reproduced before the repair. Delivery and live evidence are recorded in the task checkpoint.
