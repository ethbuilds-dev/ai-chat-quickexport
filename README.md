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
3. Choose .md or .json
4. Save

## Custom labels

Default: `USER` / `ASSISTANT`. Change to anything in the popup. Saved automatically.

## Privacy

No data collection. No external servers. No tracking. Everything local.

## Changelog

- **1.4.3** — Fix ChatGPT 403 errors. OpenAI tightened Cloudflare bot-protection on `chatgpt.com/backend-api/*`, which started rejecting the extension's background fetch. The ChatGPT fetch now runs inside the page context, so it looks identical to ChatGPT's own request and is no longer blocked. Claude/Gemini/Grok unchanged.

## License

MIT

## Built by

[ethbuilds.dev](https://ethbuilds-dev.github.io/ai-chat-quickexport/)
