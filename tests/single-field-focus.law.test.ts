import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fieldFocusOwner,
  installSingleFieldFocus,
  FOCUS_OWNER_ATTRIBUTE,
} from '../src/lib/singleFieldFocus.mjs';

function fixture() {
  const listeners = new Map();
  const document = {
    defaultView: { getComputedStyle: (node) => node.style },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const node = ({
    parent = null,
    field = false,
    width = 200,
    height = 44,
    border = false,
    rounded = false,
  } = {}) => {
    const attributes = new Map(),
      children = [];
    const element = {
      ownerDocument: document,
      parentElement: parent,
      children,
      style: {
        borderTopWidth: border ? '1px' : '0px',
        borderTopStyle: 'solid',
        borderTopLeftRadius: rounded ? '22px' : '0px',
        backgroundColor: rounded ? '#111' : 'transparent',
        boxShadow: 'none',
      },
      matches: () => field,
      getBoundingClientRect: () => ({ width, height }),
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: (key) => attributes.delete(key),
      hasAttribute: (key) => attributes.has(key),
      contains: (target) => target === element || children.some((child) => child.contains(target)),
      querySelectorAll: () =>
        children.flatMap((child) => [
          ...(child.matches() ? [child] : []),
          ...child.querySelectorAll(),
        ]),
    };
    for (const side of ['Right', 'Bottom', 'Left']) {
      element.style[`border${side}Width`] = border ? '1px' : '0px';
      element.style[`border${side}Style`] = 'solid';
    }
    parent?.children.push(element);
    return element;
  };
  document.documentElement = node();
  document.body = node({ parent: document.documentElement });
  const focus = (target) => {
    if (document.activeElement) listeners.get('focusout')?.({ target: document.activeElement });
    document.activeElement = target;
    listeners.get('focusin')?.({ target });
  };
  return { document, node, focus, listeners };
}

test('a pill search uses its existing painted well while a standalone field owns its own edge', () => {
  const f = fixture();
  const well = f.node({ parent: f.document.body, width: 280, border: true, rounded: true });
  const search = f.node({ parent: well, field: true });
  search.style.boxShadow = '0 0 0 4px blue'; // legacy ring during its transition
  const plain = f.node({ parent: f.document.body, field: true, border: true });
  assert.equal(fieldFocusOwner(search), well);
  assert.equal(fieldFocusOwner(plain), plain);
});

test('a divider inside a painted search well is not a second field frame', () => {
  const f = fixture();
  const well = f.node({ parent: f.document.body, width: 280, border: true, rounded: true });
  const search = f.node({ parent: well, field: true });
  search.style.borderLeftWidth = '1px';
  search.style.borderLeftStyle = 'solid';
  assert.equal(fieldFocusOwner(search), well);
});

test('multi-field forms and large panels never become a giant focus frame', () => {
  const f = fixture();
  const form = f.node({ parent: f.document.body, width: 280, border: true });
  const first = f.node({ parent: form, field: true });
  f.node({ parent: form, field: true });
  assert.equal(fieldFocusOwner(first), first);
  const panel = f.node({ parent: f.document.body, width: 500, height: 400, border: true });
  const field = f.node({ parent: panel, field: true });
  assert.equal(fieldFocusOwner(field), field);
});

test('one owner follows focus, clears on blur, and detaches cleanly on app unmount', () => {
  const f = fixture();
  const well = f.node({ parent: f.document.body, width: 280, border: true });
  const search = f.node({ parent: well, field: true });
  const other = f.node({ parent: f.document.body, field: true, border: true });
  const cleanup = installSingleFieldFocus(f.document);
  f.focus(search);
  assert.ok(well.hasAttribute(FOCUS_OWNER_ATTRIBUTE));
  f.focus(other);
  assert.ok(!well.hasAttribute(FOCUS_OWNER_ATTRIBUTE));
  assert.ok(other.hasAttribute(FOCUS_OWNER_ATTRIBUTE));
  f.focus(f.document.body);
  assert.ok(!other.hasAttribute(FOCUS_OWNER_ATTRIBUTE));
  f.focus(search);
  cleanup();
  assert.ok(!well.hasAttribute(FOCUS_OWNER_ATTRIBUTE));
  assert.equal(f.listeners.size, 0);
  assert.ok(!f.document.documentElement.hasAttribute('data-sp-single-field-focus'));
});

test('an already focused field gets the same treatment after hydration', () => {
  const f = fixture();
  const field = f.node({ parent: f.document.body, field: true, border: true });
  f.document.activeElement = field;
  const cleanup = installSingleFieldFocus(f.document);
  assert.ok(field.hasAttribute(FOCUS_OWNER_ATTRIBUTE));
  cleanup();
});

test('global app wiring opts in after installation and keeps one inset edge without layout shifts', () => {
  const css = readFileSync('src/styles/single-field-focus.css', 'utf8');
  const app = readFileSync('src/main.tsx', 'utf8');
  assert.match(app, /installSingleFieldFocus\(document\)/);
  const standalone = readFileSync('src/diamond-test.tsx', 'utf8');
  assert.match(standalone, /installSingleFieldFocus\(document\)/);
  assert.match(standalone, /single-field-focus\.css/);
  assert.match(css, /html\[data-sp-single-field-focus\] body/);
  assert.match(css, /outline-offset: -2px/);
  assert.match(css, /box-shadow: none !important/);
  assert.doesNotMatch(css, /border-width:|padding:|height:/);
});
