# Native verification fixtures retain the published client

Native PostgreSQL fixtures and migration verification metadata were still treated
as client build inputs. Their routine updates forced static publications and
superseded long hosted browser certificates, despite unchanged client sources.

Classify the native CI fixture directory as a verification component, alongside
the existing qualification directory. Exclude the two reviewed migration metadata
files and the native private-join rehearsal and SQL fixture. No general CI-script
or JSON exemption is introduced. All observed build files and watched scopes still
override these boundaries, including additions and deletions. Dependency manifests
and unknown neighbouring tools remain conservative. Existing inventories remain
immutable; one normal publication establishes the updated baseline.

The maintained real Git/Vite regression covers unseen native fixtures, imported
native fixtures, watched additions, deletion of an observed file, dependency files
inside fixture directories, and unknown neighbouring metadata. Existing CI and
normal pre-push hooks execute the suite.
