# 2026-09-29 - Closing an account takes their pictures with it

Close Account (`fn_close_account`, migration 20260929051751) cleared the links
to the person's pictures from their profile (`avatar_url`, `cover_photo_url`,
`arena_avatar_url`) but left the pictures. The store notes say closing removes
them; it did not.

## What stayed, measured on production before the change

- `public.user_avatars`, the avatar record: 7 rows, 6 of them custom, each with
  `custom_image_url` (the made-for-them avatar) and `custom_prompt` (the words
  that described them to the image model).
- `public.user_media` and `public.user_albums`, the profile editor's media
  library of profile and cover pictures: empty today, kept all the same.
- The files, in Storage:
  - `social-media`, `avatars/<id>/`: the profile photo a player uploads
    (1 today). Anon and signed-in users can LIST `avatars/%` in this bucket
    (policy `preset_avatars_are_listable`, there for the preset gallery), so a
    closed account's photo stayed findable by anyone who knows the id.
  - `social-media`, `covers/<id>/`: cover photos (7).
  - `avatars`, `<id>/`: an avatar generated for the account (548, nearly all
    the house players').
  - `custom-avatars`, `generated/`: avatars made from a player's photo
    (`likeness_<id>_`, 4), their words (`<id>_`, 34) or an edit (`edited_<id>_`,
    4).

All three tables reference `auth.users` ON DELETE CASCADE: they were meant to
go with the person. The soft delete that keeps the financial journals never
cascades.

## What changed

- Migration `20260929070440_closing_an_account_takes_their_pictures`:
  `fn_close_account`, otherwise unchanged, deletes the person's `user_avatars`,
  `user_media` and `user_albums` rows with the other personal, non-financial
  rows, in the same transaction, after every settlement check. The erasure
  summary counts them. Applied 07:04 UTC, after the break window and the
  engine maintenance release; the live body's md5 matches the file's
  (029aff7fd659700f069f06d7d696d05c).
- The World Hub's DELETE `/api/auth/delete-account` removes the files, through
  the Storage API, once `fn_close_account` has answered ok: the folders and
  name prefixes above, each name checked against the exact prefix before it
  is removed. SQL cannot remove a stored file (`storage.protect_objects_delete`
  refuses, and deleting the row would orphan the file). A file that cannot be
  removed does not stop the closure: the account still closes, the failure is
  reported, and the erasure request stays `anonymized` instead of `completed`
  so support can see it.
- `tests/an-account-closes-without-touching-the-books.law.test.ts` holds the
  function to it: the three picture links cleared, the three tables deleted.

## What stays, on purpose

Photos and videos a player POSTED stay with their posts, like the posts
themselves; message attachments stay with the conversation the other person
still has. Whether a closed account's posts and messages should go too is a
decision, not a fix.
