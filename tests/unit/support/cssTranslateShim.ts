/**
 * jsdom has no CSS `translate` property: assigning it creates a plain expando
 * that `removeProperty('translate')` cannot clear, so a hook that resets and
 * re-places a node looks, in jsdom, as if it never moved it. Back the property
 * with a real declaration so tests see what a browser does.
 */
const KEY = '--jsdom-translate';

export function installCssTranslateShim(): () => void {
  const proto = CSSStyleDeclaration.prototype as CSSStyleDeclaration & { translate: string };
  const own = Object.getOwnPropertyDescriptor(proto, 'translate');
  const remove = proto.removeProperty;
  Object.defineProperty(proto, 'translate', {
    configurable: true,
    get(this: CSSStyleDeclaration) {
      return this.getPropertyValue(KEY);
    },
    set(this: CSSStyleDeclaration, value: string) {
      if (value) this.setProperty(KEY, value);
      else remove.call(this, KEY);
    },
  });
  proto.removeProperty = function (this: CSSStyleDeclaration, name: string) {
    return remove.call(this, name === 'translate' ? KEY : name);
  };
  return () => {
    proto.removeProperty = remove;
    if (own) Object.defineProperty(proto, 'translate', own);
    else delete (proto as { translate?: string }).translate;
  };
}
