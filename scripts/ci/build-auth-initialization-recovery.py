#!/usr/bin/env python3
"""Rebuild the version-bound auth-js archive; --check verifies without writing."""
import argparse
import base64
import copy
import difflib
import gzip
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

VERSION = '2.90.1'
URL = f'https://registry.npmjs.org/@supabase/auth-js/-/auth-js-{VERSION}.tgz'
INTEGRITY = 'sha512-vxb66dgo6h3yyPbR06735Ps+dK3hj0JwS8w9fdQPVZQmocSTlKUW5MfxSy99mN0XqCCuLMQ3jCEiIIUU23e9ng=='
ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'vendor' / 'supabase-auth-js'


def patch(text, source, commonjs):
    indent = '  ' if source else '    '
    signature = 'async initialize(): Promise<InitializeResult> {' if source else 'async initialize() {'
    start = text.index(indent + signature)
    end = text.index('\n' + indent + '}', start) + len('\n' + indent + '}')
    original = text[start:end]
    assert original.count('await this.initializePromise') == 2
    before, after = text[:start], text[end:]
    assert before.count('this.initialize()') == 1
    assert (before + after).count('await this.initializePromise') == 11
    before = before.replace('this.initialize()', "this.initialize().catch((error" + (': any' if source else '') + ") => {\n" + indent * 3 + "console.warn('[AuthClient] Initial session admission failed', error?.name ?? 'Error')\n" + indent * 2 + '})', 1)
    before = before.replace('await this.initializePromise', 'await this.initialize()')
    after = after.replace('await this.initializePromise', 'await this.initialize()')
    subscription_end = ("    })()\n\n    return { data: { subscription } }" if source else
                        "        })();\n        return { data: { subscription } };")
    subscription_catch = ("    })().catch((error: any) => {\n      console.warn('[AuthClient] Initial auth subscription admission failed', error?.name ?? 'Error')\n    })\n\n    return { data: { subscription } }" if source else
                          "        })().catch((error) => {\n            console.warn('[AuthClient] Initial auth subscription admission failed', error?.name ?? 'Error');\n        });\n        return { data: { subscription } };")
    assert after.count(subscription_end) == 1
    after = after.replace(subscription_end, subscription_catch, 1)
    lock_error = 'locks_1.LockAcquireTimeoutError' if commonjs else 'LockAcquireTimeoutError'
    body = f'''{signature}
  if (this.initializePromise) {{
    return await this.initializePromise
  }}
  let entered = false
  const initialization{': Promise<InitializeResult>' if source else ''} = (async () => {{
    try {{
      return await this._acquireLock(this.lockAcquireTimeout, async () => {{
        entered = true
        return await this._initialize()
      }})
    }} catch (error{': any' if source else ''}) {{
      // An unacquired lock executed no initializer effects. Retire only this
      // failed generation; a later explicit API request may initialize anew.
      if (!entered && this.initializePromise === initialization &&
          (error?.name === 'AbortError' || error instanceof {lock_error})) {{
        this.initializePromise = null
      }}
      throw error
    }}
  }})()
  this.initializePromise = initialization
  return await initialization
}}'''
    replacement = '\n'.join(indent + line if line else '' for line in body.splitlines())
    return before + replacement + after


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    original = args.upstream.read_bytes() if args.upstream else urllib.request.urlopen(URL).read()
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(original).digest()).decode()
    if actual != INTEGRITY:
        raise SystemExit('Upstream auth-js integrity mismatch; refusing to patch different bytes')
    targets = {'package/src/GoTrueClient.ts', 'package/dist/main/GoTrueClient.js', 'package/dist/module/GoTrueClient.js'}
    archive = io.BytesIO()
    diffs = []
    changed = set()
    with tarfile.open(fileobj=io.BytesIO(original), mode='r:gz') as upstream:
        with gzip.GzipFile(filename='', mode='wb', fileobj=archive, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as output:
                for entry in upstream:
                    content = upstream.extractfile(entry).read() if entry.isfile() else None
                    if entry.name in targets:
                        old = content.decode()
                        new = patch(old, '/src/' in entry.name, '/dist/main/' in entry.name)
                        content = new.encode()
                        diffs.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + entry.name, tofile='b/' + entry.name))
                        changed.add(entry.name)
                    info = copy.copy(entry)
                    if content is not None:
                        info.size = len(content)
                    output.addfile(info, io.BytesIO(content) if content is not None else None)
    if changed != targets:
        raise SystemExit('Missing a maintained source or runtime target')
    results = {
        DIRECTORY / f'auth-js-{VERSION}-initialization-recovery.tgz': archive.getvalue(),
        DIRECTORY / 'initialization-recovery.patch': ''.join(diffs).encode(),
    }
    for path, data in results.items():
        if args.check:
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit(f'Generated auth-js artifact differs: {path.name}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    print('Verified auth-js 2.90.1: exactly three implementation files changed; other archive entries retained')


if __name__ == '__main__':
    main()
