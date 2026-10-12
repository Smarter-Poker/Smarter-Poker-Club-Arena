import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLOSED_DISCLOSURE_BODY_SELECTOR } from '../e2e/support/closedDisclosureBody';

const isClosedDisclosureBody = (node: Element) =>
  Boolean(node.closest(CLOSED_DISCLOSURE_BODY_SELECTOR));

function element(html: string, id: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const node = host.querySelector(`#${id}`);
  if (!node) throw new Error('Fixture Element Missing');
  return node;
}

describe('Readable chrome audit disclosure boundaries', () => {
  it('excludes a closed body while retaining its readable summary', () => {
    const html =
      '<details><summary id="summary"><span id="label">Definitions</span></summary><div><p id="body">Units</p></div></details>';
    expect(isClosedDisclosureBody(element(html, 'body'))).toBe(true);
    expect(isClosedDisclosureBody(element(html, 'summary'))).toBe(false);
    expect(isClosedDisclosureBody(element(html, 'label'))).toBe(false);
  });

  it('includes the open body and ordinary page content', () => {
    expect(
      isClosedDisclosureBody(
        element(
          '<details open><summary>Definitions</summary><p id="body">Units</p></details>',
          'body'
        )
      )
    ).toBe(false);
    expect(isClosedDisclosureBody(element('<div><p id="body">Units</p></div>', 'body'))).toBe(
      false
    );
  });

  it('keeps an inner open summary hidden while its outer disclosure is closed', () => {
    expect(
      isClosedDisclosureBody(
        element(
          '<details><summary>Outer</summary><div><details open><summary id="inner">Inner</summary><p id="body">Units</p></details></div></details>',
          'inner'
        )
      )
    ).toBe(true);
  });

  it('retains an inner closed summary when its outer disclosure is open', () => {
    expect(
      isClosedDisclosureBody(
        element(
          '<details open><summary>Outer</summary><div><details><summary id="inner">Inner</summary><p id="body">Units</p></details></div></details>',
          'inner'
        )
      )
    ).toBe(false);
  });

  it('uses the exact tested classification in the serialized production probe', () => {
    const probe = readFileSync('tests/e2e/mobile-chrome-occlusion.spec.ts', 'utf8');
    expect(probe).toContain('if (el.closest(closedDisclosureBodySelector)) continue;');
    expect(probe).toContain('closedDisclosureBodySelector: CLOSED_DISCLOSURE_BODY_SELECTOR');
    expect(probe).toContain(').toEqual([]);');
  });
});
