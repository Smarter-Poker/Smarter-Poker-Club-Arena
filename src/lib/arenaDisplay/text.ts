/** Owner rule, 2026-10-09: no dollar signs in either arena's displayed copy. */
export function arenaDisplayText(text: string): string {
  return text.replace(/[$＄﹩]/g, '');
}

function displayChildren(value: unknown): unknown {
  if (typeof value === 'string') return arenaDisplayText(value);
  if (Array.isArray(value)) {
    const normalized = value.map(displayChildren);
    return normalized.some((child, index) => child !== value[index]) ? normalized : value;
  }
  return value;
}

/** Transform display fields before React renders. Never alter routing, IDs,
 * event handlers, model objects, or financial data passed to components. */
export function arenaDisplayProps(type: unknown, props: unknown): unknown {
  if (!props || typeof props !== 'object') return props;
  const input = props as Record<string, unknown>;
  const output = { ...input };
  if ('children' in input) output.children = displayChildren(input.children);
  if (typeof type === 'string') {
    for (const key of [
      'title',
      'alt',
      'placeholder',
      'aria-label',
      'aria-description',
      'aria-valuetext',
    ]) {
      if (typeof input[key] === 'string') output[key] = arenaDisplayText(input[key]);
    }
    // Option values are machine identifiers; only their children are copy.
    // Passwords and hidden fields are never display copy.
    if (
      (type === 'input' && !['password', 'hidden'].includes(String(input.type))) ||
      type === 'textarea'
    ) {
      for (const key of ['value', 'defaultValue']) {
        if (typeof input[key] === 'string') output[key] = arenaDisplayText(input[key]);
      }
    }
  }
  return Object.keys(output).some((key) => output[key] !== input[key]) ? output : props;
}
