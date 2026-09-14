# Keep the Vault key launcher in the immutable fixture image

The first combined role/provider native run built its exact image, then failed during PostgreSQL bootstrap before any new qualification. Its retained diagnostic is a generic assertion; all five outer cleanup checks passed.

Source inspection identifies an incompatible startup path: the fixture generated an executable Vault key script under `/run`, while Docker's tmpfs defaults include `noexec`. The pinned Vault source requires executable access and runs that path during preload. The launcher now ships in the immutable image, reads one fixed private key file, and is exercised before PostgreSQL starts. The fresh key is read-only data in private disposable storage. Mount protections remain unchanged.

The fixture reports separate bounded bootstrap stages so a later failure can be located without publishing private logs. Tests exercise real private files, reuse and symlink refusals, the actual launcher, and the immutable-launcher contract. The previous source fails that contract. Native PostgreSQL/provider qualification remains required; this source correction is not a production or full-schema certificate.

Primary sources: [Docker tmpfs options](https://github.com/moby/moby/blob/v28.0.0/daemon/oci_linux.go#L489-L501), [pinned Vault preload](https://github.com/supabase/vault/blob/6e0cd916242d922a646e4d611cc215e09dd429f4/src/supabase_vault.c#L31-L79).
