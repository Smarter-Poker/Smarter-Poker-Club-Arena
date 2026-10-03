# Club Creation Certification Reaches Retirement

2026-10-03

## What Failed

Every Club Create Certification run after #5919 reached the published opening
wizard and then timed out (runs `37098573844`, `37099058184`) waiting for a
field named exactly `Club Tag Line`. The field's accessible name was
`Club Tag Line 0 Of 72 Characters`: the live character counter sat inside the
`<label>`, so assistive technology heard a different field name on every
keystroke. Two later lines of the certificate had the same class of defect and
had never been reached: `Not Now` is a choice card whose name also carries its
explanation, and the retirement dialog of a pristine welcome club names
`100,000` twice (the verified opening grant and the canonical wallet total), a
strict-mode ambiguity.

## What Changed

- Product: the tag-line input is named `Club Tag Line`; the counter is its
  accessible description (`aria-describedby`). Layout is unchanged.
- Certificate: the disabled `Not Now` card is matched by its title prefix, and
  the retirement dialog proves the opening-grant line and the wallet-total line
  separately.
- The component behaviour test pins the exact field name and the live
  description.

No database function, wallet, ledger or engine path changed. Real owners were
never blocked by these locators; the counter change is an accessibility fix.
