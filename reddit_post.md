# Reddit Post — r/ChatGPT

## Title:
I built a free Chrome extension that exports full conversations from ChatGPT, Claude, Gemini & Grok — via API, not DOM scraping

## Body:

ChatGPT's built-in export has been broken for months — long conversations get truncated, copy-paste loses formatting, print-to-PDF gives empty pages.

I got frustrated enough to build **AI Chat QuickExport** — a Chrome extension that uses each platform's internal API to fetch your complete conversation history. Every message, every turn, no matter how long the conversation.

**What it does:**
- Exports full conversations from ChatGPT, Claude, Gemini, and Grok
- Uses the internal API (ChatGPT, Claude, Grok) or clean DOM extraction (Gemini)
- Outputs as Markdown (.md) or JSON
- Custom speaker labels — name the participants whatever you want
- One click from the extension popup, saves with file dialog

**Why API instead of DOM scraping:**
ChatGPT lazy-loads messages — only what's visible is in the DOM. If your conversation has 1000+ messages, a DOM scraper gets maybe 20. The API returns everything.

**Privacy:**
Zero data collection. No external servers. No analytics. Everything happens locally in your browser. Auth tokens are captured temporarily in memory and never stored or transmitted.

**Install:**
- [GitHub repo](https://github.com/ethbuilds-dev/ai-chat-quickexport) — load as unpacked extension
- Chrome Web Store — submitted, pending review

Open source, MIT license. Feedback welcome.

---

*Built by ethbuilds.dev*
