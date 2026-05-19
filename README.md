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

## Usage

1. Open a conversation on any supported platform
2. Click the QuickExport icon
3. Choose .md or .json
4. Save

## Custom labels

Default: `USER` / `ASSISTANT`. Change to anything in the popup. Saved automatically.

## Privacy

No data collection. No external servers. No tracking. Everything local.

## License

MIT

## Built by

[ethbuilds.dev](https://ethbuilds-dev.github.io/ai-chat-quickexport/)
