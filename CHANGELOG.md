# Changelog

## 1.8.0

1.8.0 — "Text only (no images, single .md)" option in the popup. Ticked, a Markdown export downloads no images or attachments and writes one .md straight away instead of a .zip; each image or attachment becomes a short note ([image omitted], [attachment omitted: name]). Off by default, remembered between sessions. .md only: .json and .html export as before.

## 1.7.2

1.7.2 — per-message timestamps (ChatGPT create_time, Claude created_at) in JSON/MD/HTML; local time; null when the platform does not provide it.

(Grok: createTime is read when present. Gemini and AI Studio are DOM-scraped and carry no times.)

Earlier versions: see the changelog section in README.md.
