# AI Chat QuickExport

Export full conversations from ChatGPT, Claude, Gemini & Grok — every message, every turn, one click.

## Why

AI platforms keep breaking their export. ChatGPT truncates long conversations. Copy-paste loses formatting. Print gives empty pages.

QuickExport uses each platform's internal API to fetch your **complete** conversation history — not just what's visible on screen.

## Supported platforms

| Platform | Method | Status |
|----------|--------|--------|
| ChatGPT | Internal API | ✅ |
| Claude | Internal API | ✅ |
| Grok | Internal API | ✅ |
| Gemini | DOM extraction | ✅ |

## Export formats

- **Markdown (.md)** — clean `[SPEAKER]` labels
- **JSON** — structured data
- **HTML** — one self-contained page with the images embedded; double-click to read

Conversations with images or attachments export as a `.zip`: the document plus an
`assets/` folder whose filenames encode where each image sat in the log
(`msg012-img1.png`). Text-only conversations still export as a single plain file,
byte-identical to earlier versions.

## Install

### Chrome Web Store
*(Under review)*

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

## Changelog

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
