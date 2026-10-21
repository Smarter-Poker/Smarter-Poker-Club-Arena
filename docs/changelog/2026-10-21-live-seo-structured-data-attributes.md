# Live SEO checks recognize the published structured-data script

Post-deploy run 39681946162 reported missing JSON-LD on every public page even though the production head contained `<script id="route-jsonld" type="application/ld+json">`. The checker required `type` to be the first attribute and the only attribute.

Read the JSON-LD type independently of attribute order, allowing the existing script ID, extra attributes and valid HTML quoting. Preserve JSON parsing and missing-type failures. The existing parser regression suite covers the exact deployed tag, attributes after the type, single quotes, malformed JSON, unrelated script types and `data-type` impostors. No page metadata, publication gate, assertion or engine behavior changes.
