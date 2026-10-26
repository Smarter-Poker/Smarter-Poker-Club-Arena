# Installed Top-Up Predecessor For Entry-Blind Qualification

`lightning-entry-top-up-predecessor.sql` is an immutable native-fixture input, not an installation migration. Never replay it against production.

Source: PR #8045, commit `f067c166823b75bebee5454513edf8bc4b42d8bf`, file `supabase/migrations/20261025151354_lightning_top_up_original_intents_finish_at_the_final_hand_b.sql`. Read-only production history records these exact statement bytes as version `20261025154522`. The source file and installed statement both hash to MD5 `4db48e1284bab7718d0ac32ae24b5179`; SHA-256 `0526000b44ea70805aa49cdd68cb123e82cf3a561988e73854831331285eba9c`.

The live formation definition is `7b61caed8bde5127d965292c73e57915`, reservation-release definition `8b237f0f6891ff1bd1abb6008b343498`, and matcher definition remains `f35a6343a51e57c032bde2fcf7372d4b`. The native harness installs this exact input after the prior void-stamp migration and before entry blinds, then proves both entry-blind semantics and preservation of the newer intent boundary. Other tasks retain ownership of their original migration and deployment.

The adjacent preimages fixture captures the live legality and seat-follow trigger definitions. The one top-up edit in each is reversed exactly once; the current live postimages are `5c93a296a71bcb65508b4ad9b1a4a303` and `0f738b5541890d55753de110b23d3dc7`, and the derived preimages must equal `12f205a7d67fa3662ec3e88dcad1f506` and `c813c6ea7e46dbada0b9164405ee11b1` before the unchanged installed SQL can apply. Historical parity assertions run before this current-catalog boundary.
