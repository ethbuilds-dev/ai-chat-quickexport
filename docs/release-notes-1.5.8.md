# v1.5.8 — the pictures come home

The 1.5 line does one thing 1.4 could not: it exports the **images** too, and it
proves it rather than claiming it.

## What's new since 1.4.3

**Media export.** A conversation containing images now saves as a `.zip` — the
document plus an `assets/` folder whose filenames encode where each image sat in
the log (`msg012-img1.png`), so a picture can always be matched back to the
message it belonged to. Links are rewritten in place. Text-only conversations
still save as a single plain file, byte-identical to before.

**A third format: self-contained HTML.** One page with the images embedded.
Double-click it and it opens anywhere, offline, with everything still where it
was.

**It works at scale.** The original failure was size, not versions: the old bulk
transfer put every image into a single browser message, and a ~100-image
conversation (~200 MB encoded) blew past Chrome's ~64 MB per-message ceiling, so
the whole batch died and every picture landed in the export as a "not exported"
note. Fetching is now one message per asset, with a live progress bar, and
transient upstream failures (5xx / 429 / network) are retried three times before
an image is given up on.

**Field proof, not a claim.** The conversation that failed on 6 August was
re-exported end to end on a live account: **0 of 97 images → 102 of 102 assets,
207.1 MB**, zero "not exported" notes, zero unresolved placeholders. Receipt:
[`docs/v1.5-FIELD-PROOF-2026-08-22.md`](docs/v1.5-FIELD-PROOF-2026-08-22.md).

**Grok media, read from real data instead of guessed.** Files you uploaded are
declared across three parallel arrays and identified by a storage key rather than
a URL — which is why every earlier version walked straight past them. Images Grok
generated for you write an *empty* tag into the message and keep the picture, its
prompt and its address in a separate field; those download into `assets/` with
the prompt carried along as alt text, because a generated image without its prompt
is half a record.

**Smaller things that stop you losing work.** The popup now names the platform and
conversation it is pointed at *before* you click. The filename you typed and the
last result are remembered per conversation (200 most recent, 90-day expiry), so
dismissing the popup no longer resets you. Your filename reaches the disk exactly
as typed — Chrome was substituting an extension from the OS MIME registry, turning
`.json` into `.customization` on some machines. Asset names are hardened against
bidirectional-override and control characters, and follow the real file signature
rather than the name the platform supplies (claude.ai serves every image
re-encoded as WebP while keeping the original filename).

**Verification.** 206 unit checks (`node tests/run-tests.js`) and 53 adversarial
attacks (`node tests/adversarial.js`), all passing on this tag.

## Read this before you update

This version adds two host permissions — `*.oaiusercontent.com` and
`assets.grok.com` — because the images live on those hosts and cannot be fetched
without them. **Chrome disables an extension whose update requests new hosts until
you approve them**, so you will see "needs permission" once and have to click it.
That is the update, not a fault.

The `downloads` permission was **removed** in 1.5.2 — one download path now serves
every format.

## What this does not do

Written here so nobody finds out the hard way:

- **Gemini is best effort.** Google exposes no clean conversation API, so Gemini is
  read from the rendered page: **text only, no image export**, long conversations
  must be **scrolled to the top first** (turns never rendered are not there to
  read), and a Google front-end redesign can break it without warning. It is
  included because a text transcript beats no transcript.
- **Grok media may be incomplete.** Grok's format is undocumented and has changed
  more than once. Every shape handled here was measured against live
  conversations; a shape nobody has seen yet can still come out as text without
  its picture. Whatever cannot be fetched is **named in the export** rather than
  dropped silently.
- **Images Grok returned from a web search are exported as links, not files** — on
  purpose. They are other people's pictures on arbitrary sites, and bundling them
  would require permission to read every site you visit. The export keeps the
  title, the source site and both links.
- **Documents uploaded into Claude cannot be retrieved.** They arrive as `blob`
  records with no served URL (eight candidate endpoints tried against a live
  account, all 404). They are listed as present-but-unavailable instead of being
  reported as a failed download.

## Install

The Chrome Web Store still carries 1.4.0 while 1.5.8 goes through review. Until it
clears: download `ai-chat-quickexport-v1.5.8.zip` below, unzip it,
`chrome://extensions/` → Developer mode → **Load unpacked** → select the folder.
Do not move the folder afterwards; Chrome remembers the path.

MD5 of the attached package: `13971c261a120bee5ae283ed507fa83b`
