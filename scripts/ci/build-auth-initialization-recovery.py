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
  {'let initialization!: Promise<InitializeResult>;' if source else ''}
  {'initialization' if source else 'const initialization'} = (async () => {{
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
    replacement = '\n'.join(indent + line if line.strip() else '' for line in body.splitlines())
    return before + replacement + after


def patch_admission(text, source):
    if source:
        field = '  protected pendingInLock: Promise<any>[] = []'
        replacement = field + """
  private pendingLockAcquisition: {
    timeout: number
    waiting: { fn: () => Promise<any>; resolve: (value: any) => void; reject: (reason: any) => void }[]
  } | null = null"""
    else:
        field = '        this.pendingInLock = [];'
        replacement = field + '\n        this.pendingLockAcquisition = null;'
    assert text.count(field) == 1
    text = text.replace(field, replacement, 1)
    indent = '  ' if source else '    '
    signature = ('private async _acquireLock<R>(acquireTimeout: number, fn: () => Promise<R>): Promise<R> {'
                 if source else 'async _acquireLock(acquireTimeout, fn) {')
    start = text.index(indent + signature)
    end = text.index('\n' + indent + '}', start) + len('\n' + indent + '}')
    original = text[start:end]
    assert original.count('this.lockAcquired = true') == 1
    assert original.count('await result') == 4
    body = """SIGNATURE
  this._debug('#_acquireLock', 'begin', acquireTimeout)
  // Only admitted operations enter pendingInLock. Waiting for a native
  // acquisition must never be mistaken for owning that native lock.
  const enqueue = ENQUEUE => {
    const last = this.pendingInLock.length
      ? this.pendingInLock[this.pendingInLock.length - 1] : Promise.resolve()
    const result = (async () => { await last; return await operation() })()
    this.pendingInLock.push(result.then(() => {}, () => {}))
    return result
  }
  try {
    if (this.lockAcquired) return await enqueue(fn)
    const pending = this.pendingLockAcquisition
    if (acquireTimeout > 0 && pending && pending.timeout === acquireTimeout) {
      return await new Promise<PROMISE_TYPE>((resolve, reject) => {
        pending.waiting.push({ fn, resolve, reject })
      })
    }
    // Immediate probes and other budgets keep their independent native request.
    const admissionADMISSION_TYPE = acquireTimeout > 0 && !pending
      ? { timeout: acquireTimeout, waiting: [] } : null
    if (admission) this.pendingLockAcquisition = admission
    let entered = false
    try {
      return await this.lock(`lock:${this.storageKey}`, acquireTimeout, async () => {
        entered = true
        this.lockAcquired = true
        if (this.pendingLockAcquisition === admission) this.pendingLockAcquisition = null
        this._debug('#_acquireLock', 'lock acquired for storage key', this.storageKey)
        try {
          // Enqueue the complete admitted cohort before the first callback runs.
          const result = enqueue(fn)
          for (const request of admission?.waiting ?? []) {
            enqueue(request.fn).then(request.resolve, request.reject)
          }
          if (admission) admission.waiting.length = 0
          try {
            return await result
          } finally {
            // A failed first operation cannot release native ownership while
            // subsequent admitted operations are still executing.
            while (this.pendingInLock.length) {
              const waitOn = [...this.pendingInLock]
              await Promise.all(waitOn)
              this.pendingInLock.splice(0, waitOn.length)
            }
          }
        } finally {
          this.lockAcquired = false
          this._debug('#_acquireLock', 'lock released for storage key', this.storageKey)
        }
      })
    } catch (errorERROR_TYPE) {
      if (!entered && admission) {
        for (const request of admission.waiting) request.reject(error)
        admission.waiting.length = 0
      }
      throw error
    } finally {
      if (admission && this.pendingLockAcquisition === admission) this.pendingLockAcquisition = null
    }
  } finally {
    this._debug('#_acquireLock', 'end')
  }
}"""
    body = body.replace('SIGNATURE', signature)
    body = body.replace('ENQUEUE', '(<T>(operation: () => Promise<T>): Promise<T>' if source else '(operation)')
    # Close the generic arrow's parameter list (the surrounding parens are not needed).
    body = body.replace('const enqueue = (<T>', 'const enqueue = <T>')
    body = body.replace('ADMISSION_TYPE', ': typeof this.pendingLockAcquisition' if source else '')
    body = body.replace('ERROR_TYPE', ': any' if source else '')
    body = body.replace('new Promise<PROMISE_TYPE>', 'new Promise<R>' if source else 'new Promise')
    replacement = '\n'.join(indent + line if line.strip() else '' for line in body.splitlines())
    return text[:start] + replacement + text[end:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    original = args.upstream.read_bytes() if args.upstream else urllib.request.urlopen(URL).read()
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(original).digest()).decode()
    if actual != INTEGRITY:
        raise SystemExit('Upstream auth-js integrity mismatch; refusing to patch different bytes')
    targets = {'package/src/GoTrueClient.ts', 'package/dist/main/GoTrueClient.js', 'package/dist/module/GoTrueClient.js', 'package/dist/main/GoTrueClient.d.ts', 'package/dist/module/GoTrueClient.d.ts'}
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
                        if entry.name.endswith('.d.ts'):
                            assert old.count('    protected pendingInLock: Promise<any>[];') == 1
                            new = old.replace('    protected pendingInLock: Promise<any>[];', '    protected pendingInLock: Promise<any>[];\n    private pendingLockAcquisition;', 1)
                        else:
                            source = '/src/' in entry.name
                            new = patch_admission(patch(old, source, '/dist/main/' in entry.name), source)
                        content = new.encode()
                        diffs.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + entry.name, tofile='b/' + entry.name, n=0))
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
    print('Verified auth-js 2.90.1: three implementations and two private declarations changed; other archive entries retained')


if __name__ == '__main__':
    main()
