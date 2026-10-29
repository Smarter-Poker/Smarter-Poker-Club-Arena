/** Keep Vite's dependency memo consistent with the CSS load it represents. */
export function cssPreloadRetryPlugin() {
  const helperId = '\0vite/preload-helper.js';
  const failedCss = /\(\) => rej\(new Error\(`Unable to preload CSS for \$\{dep\}`\)\)/g;
  return {
    name: 'club-arena-css-preload-retry',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      if (id !== helperId) return null;
      const matches = [...code.matchAll(failedCss)];
      if (matches.length !== 1) {
        this.error('Vite CSS preload helper changed; review failed dependency invalidation.');
      }
      return {
        code: code.replace(
          failedCss,
          `() => {
          delete seen[dep];
          link.remove();
          rej(new Error(\`Unable to preload CSS for \${dep}\`));
        }`
        ),
        map: null,
      };
    },
  };
}
