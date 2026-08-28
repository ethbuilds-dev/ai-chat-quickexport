# AI Chat QuickExport

Export full conversations from ChatGPT, Claude, Gemini & Grok — every message, every turn, one click.

## Why

AI platforms keep breaking their export. ChatGPT truncates long conversations. Copy-paste loses formatting. Print gives empty pages.

QuickExport uses each platform's internal API to fetch your **complete** conversation history — not just what's visible on screen.

## Supported platforms

| Platform | Method | Text | Images | Notes |
|----------|--------|------|--------|-------|
| ChatGPT | Internal API | ✅ full | ✅ | attachments too |
| Claude | Internal API | ✅ full | ✅ | non-image uploads are listed, not downloadable |
| Grok | Internal API | ✅ full | ⚠️ mostly | your uploads + generated images (with prompts); search images by link |
| Gemini | DOM extraction | ⚠️ best effort | ❌ | text only; scroll to the top first |

## Coverage and limits

Read this before you trust an archive to it. These are measured, not assumed.

**Gemini is best effort.** Google exposes no clean conversation API, so Gemini is
read from the rendered page. Consequences, all real: **text only — no image
export**; a long conversation must be **scrolled to the top first**, because turns
that were never rendered are not in the page to read; and a front-end redesign at
Google can break the extraction without warning. Gemini is included because a text
transcript beats no transcript — not because it is on par with the other three.

**Grok media may be incomplete.** Grok's conversation format is undocumented and
has changed more than once. Every shape this version handles was measured against
live conversations — files you uploaded, images Grok generated for you, and
web-search image cards. A shape nobody has seen yet can still come out as text
without its picture. When the extension cannot fetch something, it says so in the
export instead of dropping it silently.

**Search-result images are exported as links, on purpose.** When Grok shows you
pictures it found on the web, they are other people's images on arbitrary sites.
Packing them would require permission to read every site you visit; this extension
will not ask for that. The export keeps the title, the source site, a link to the
image and a link to the page — an archive that says *"here was a picture from
example.com, here is where"* is honest; raw markup is not.

**Claude non-image uploads cannot be retrieved.** Documents uploaded into Claude
arrive as `blob` records with no served URL — eight candidate endpoints were tried
against a live account and all returned 404. They are named in the export as
present-but-unavailable rather than reported as a download failure.

## Export formats

- **Markdown (.md)** — clean `[SPEAKER]` labels
- **JSON** — structured data
- **HTML** — one self-contained page with the images embedded; double-click to read

Conversations with images or attachments export as a `.zip`: the document plus an
`assets/` folder whose filenames encode where each image sat in the log
(`msg012-img1.png`). Text-only conversations still export as a single plain file,
byte-identical to earlier versions.

## Finding your place in a long thread

Long conversations are hard to navigate by date, because the thing that matters
is not when you wrote something - it is how far into the thread it sits. Model
context is spent in words, not in days.

So every export carries a mark every 10,000 words:

```
— 40,000 words —
```

In Markdown and HTML the marks sit inline, between messages, so you can scroll
to "around 80k" the way you would find a milestone on a road. In JSON every
message also carries `words_so_far`, and the file lists `word_milestones`, so
you can search or script against exact positions.

This is useful if you keep a memory or continuity file between threads and want
to know how far your companion holds it before losing the thread - you can point
at the place instead of guessing at it.

A single very long message can cross more than one mark. Each crossing is
reported at that message rather than guessed at a position inside it.

## Which version am I running?

Three places, in the order that costs you the least:

1. **In the extension popup** — the bottom line reads `AI Chat QuickExport vX.Y.Z`.
   It is read from the manifest at runtime, so it cannot drift from the build.
2. **`chrome://extensions`** — find AI Chat QuickExport; the version is printed
   under the name. This works on every build, including ones older than the line
   above.
3. **The exported file itself** — Markdown and JSON exports carry the exporter
   version in their header/metadata.

Added because someone using this tool asked and could not find the answer
anywhere — which was a fair complaint about the tool, not about the reader.

## Install

### Chrome Web Store
[AI Chat QuickExport](https://chromewebstore.google.com/detail/oocipcgmlmgnkkcodlnnpdddgmodhoai)
— **LIVE with 1.5.8.** Verified against Chrome's own update service on
2026-08-24, not against a dashboard screenshot: the endpoint serves
`..._1_5_8_0.crx`, `version="1.5.8"`, `status="ok"`, 45,919 bytes,
sha256 `6330d648…`. Install from the store, or unpacked below if you prefer.

### Manual install
1. Download or clone this repo
2. `chrome://extensions/` → Developer mode ON
3. Load unpacked → select this folder
4. Done

**Important:** Do not move the extension folder after loading it. Chrome references the original folder path — if you move it (e.g., Desktop → Documents), the extension will silently break. If this happens, remove the extension from `chrome://extensions/` and reload it from the new location.

## Usage

1. Open a conversation on any supported platform
2. Click the QuickExport icon
3. Choose .md, .json or .html
4. Save

## Custom labels

Default: `USER` / `ASSISTANT`. Change to anything in the popup. Saved automatically.

## Privacy

No data collection. No external servers. No tracking. Everything local.

**Permissions, and why each one exists:**

- `activeTab` — read the URL and title of the tab you clicked from, to know which
  platform and which conversation, and to show you the target before you commit.
- `scripting` — run the fetch inside the conversation page for ChatGPT (its
  servers reject the same request made from the extension's background context)
  and for Gemini (no API; the transcript exists only as DOM), plus ChatGPT's
  signed image URLs, which are only honoured from the page. Nothing is injected
  into pages you did not ask to export.
- `storage` — your two speaker labels (sync), and per conversation the filename
  you last typed plus the last success line (local), so reopening the popup does
  not lose your place. Capped at 200 conversations, expiring after 90 days. **No
  conversation content is stored.**
- Host permissions for the four platforms — to read your conversation using the
  session you are already logged into.
- `*.oaiusercontent.com` and `assets.grok.com` — the hosts that serve ChatGPT's
  and Grok's images. Needed to download the pictures into the export. Nothing is
  ever uploaded to them.

Authentication tokens from your existing session are held in memory for the
duration of one export and are never written to disk or sent anywhere but back to
the platform they came from.

**Note when updating from 1.4.0:** the two asset hosts are new permissions, and
Chrome disables an extension whose update requests new hosts until you approve
them. You will see "needs permission" once. That is the update, not a fault.

## Changelog

- **1.6.0** - Word marks. Exports now carry a `— 10,000 words —` mark at every
  10k, inline in Markdown and HTML; JSON gains `words_so_far` on each message
  and a `word_milestones` list. This exists because a user who writes with two
  AI companions put it plainly: *"I don't measure time in hours, days or weeks,
  I measure time in words. If she forgets things after 80k words, it doesn't
  matter whether that took a week or a month."* Wall-clock timestamps cannot
  answer that question; word position can.
- **1.5.8** — Files you uploaded into a Grok conversation are exported too.
  They are declared across three parallel arrays and identified by a storage
  key rather than a URL, which is why earlier versions walked straight past
  them; the key that ends in /content serves the original bytes, and that is
  what is fetched, with your own filename kept.
- **1.5.7** — Grok images that Grok made for you are now exported as files.
  A generated-image card writes an EMPTY tag into the message (it identifies
  itself only by card id) while the picture, its prompt and its address live
  in a separate field; the address is relative to Grok's asset host. Those are
  yours, so they are downloaded into assets/ like any attachment, and the
  prompt travels with them as the alt text - a generated image without its
  prompt is half a record. Adds the https://assets.grok.com/* host permission,
  which is what makes fetching them possible. Web-search images stay
  references, as in 1.5.6.
- **1.5.6** — Grok image cards are readable at last. Grok writes pictures into
  a message as `<grok:render>` tags whose data lives in a separate field, so
  until now they landed in the export as raw markup — unreadable, and hiding
  the fact that a picture had been shown at all. Each card now becomes a
  reference: the title, the site it came from, a link to the image and a link
  to the page. They are deliberately NOT downloaded: measured on a live
  conversation, Grok image cards are web-search results whose originals sit on
  arbitrary third-party sites, and bundling those would require a wildcard
  host permission this extension has no business asking for.
- **1.5.5** — The popup now tells you what it is pointed at before you click:
  the platform and the conversation name, in a line under the title. Exporting
  the wrong tab used to be something you found out afterwards. And a media
  export shows a progress bar — a hundred images is two silent minutes, which
  is the difference between "working" and "frozen".
- **1.5.4** — Hardening from an adversarial pass (53 attacks, `node
  tests/adversarial.js`). Asset names now have bidirectional-override and
  control characters stripped: a file called "photo<RLO>gnp.exe" displays as
  "photoexe.png" in any file manager, and a NUL inside a zip entry name is
  malformed enough that some extractors truncate it. Trailing dots and spaces
  are trimmed, which Windows silently does anyway — turning two different
  names into one collision. The popup memory added in 1.5.2 is now pruned:
  200 most recent conversations, nothing older than 90 days.
- **1.5.3** — Your filename reaches the disk exactly as you typed it. Chrome
  substitutes a download extension from the operating system MIME registry, so a
  .json export could arrive as .customization and a .html one as .htm depending
  on what an installer once wrote there. Downloads now carry a neutral content
  type, which is mapped nowhere, so nothing gets substituted.
- **1.5.2** — Reopening the popup no longer costs you work. Chrome destroys an
  extension popup the moment it loses focus (dismissing the download bubble is
  enough) and no API can prevent that — so the filename you typed and the last
  thing the popup told you are now remembered per conversation, and come back
  when you open it again. Also: one download path for every format, which fixes
  the Save-As dialog offering a blob UUID instead of your filename; the
  `downloads` permission is no longer needed and has been removed. And uploads
  that the platform does not serve (Claude documents arriving as `blob` with no
  URL) are now named honestly in the export instead of being reported as a
  failed download.
- **1.5.1** — Images and attachments export properly, at any size. The media
  fetch is now one message per asset with live progress: the old bulk transfer
  put every image's data into a single browser message and a ~100-image
  conversation (~200 MB encoded) blew past Chrome's ~64 MB per-message ceiling,
  so the whole batch died and every picture landed in the export as a "not
  exported" note. Transient upstream failures (5xx/429/network) are retried
  three times before an image is given up on — measured on a live account, the
  same Claude URL answered 503 once and 200 on all three retries. Asset
  filenames now follow the actual file signature rather than the name the
  platform supplies: claude.ai serves every image re-encoded as WebP while
  keeping the original filename, and a `.png` holding WebP bytes fails to open
  in some viewers.
- **1.5.0** — Media export. Images and attachments are downloaded and packed
  alongside the conversation (`assets/`, position-encoded filenames), links are
  rewritten in place, and a third format is added: a self-contained `.html`
  with the images embedded. Adds the `*.oaiusercontent.com` host permission,
  needed to fetch ChatGPT's signed image URLs.
- **1.4.3** — Fix ChatGPT 403 errors. OpenAI tightened Cloudflare bot-protection on `chatgpt.com/backend-api/*`, which started rejecting the extension's background fetch. The ChatGPT fetch now runs inside the page context, so it looks identical to ChatGPT's own request and is no longer blocked. Claude/Gemini/Grok unchanged.

## License

MIT

## Built by

[ethbuilds.dev](https://ethbuilds-dev.github.io/ai-chat-quickexport/)
