# Public Actions artifacts contain encrypted human-result reports only

The repository visibility check found that Club Arena is public. An Actions
artifact here is therefore unsuitable for unencrypted private player results.
The one successful raw artifact was recovered to owner-only local evidence and
deleted from Actions; prior unsuccessful runs uploaded no result artifact.

The maintained workflow now seals its report using AES-256-GCM and wraps the
random content key with the configured RSA recipient using OAEP-SHA256. Source
identity and recipient fingerprint are authenticated. Only ciphertext is saved
and uploaded. Missing recipient configuration refuses before any database read;
there is no plaintext fallback. The existing schedule, fourteen-day artifact
retention, read-only query bounds, snapshot and attribution guards are unchanged.

`HORSE_REPORT_RECIPIENT_PUBLIC_KEY` is an Actions variable containing only public
SPKI. The permanent private recipient is generated inside the owner's native
macOS login Keychain, scoped to this report's application tag. No private key is
exported, placed in a file, sent to Actions or passed in command arguments.

The operator helper is `scripts/horse-report-keychain.swift`. Compile it at its
durable owner path before running `provision`, then configure its public output.
Later `public` reads only that same tagged recipient. Recovery uses:

```
horse-report-keychain decrypt <downloaded-report.sealed.json> <new-private-report.json>
```

The helper uses Security's OAEP decryption and CryptoKit authenticated decryption,
refuses altered envelopes and creates a new owner-only output file. It never
prints report rows or exports the private key. Preserve the tagged Keychain item
while these business reports are needed. A locked or unavailable Keychain is an
explicit access failure, never a reason to create a plaintext key fallback.

Retained controls cover crypto round trips, tampering, weak/missing recipients,
raw artifact exclusion, direct workflow wiring and public-only native export.
The real native Keychain round trip matched the actual report byte for byte;
tampering produced no plaintext file. Actual encrypted provider publication and
independent local decryption remain separate delivery evidence.
