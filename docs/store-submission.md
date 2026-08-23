# Chrome Web Store submission — AI Chat QuickExport 1.5.8

*Everything the Web Store dashboard asks for, written out so the submission is
a copy-paste and not a re-invention. Last revised 2026-08-23, for the 1.5.8
upload. **STATUS 2026-08-24: submitted, reviewed and PUBLISHED — the store now
serves 1.5.8.** Verified against Chrome's own update endpoint rather than a
dashboard: `version="1.5.8"`, `status="ok"`, `..._1_5_8_0.crx`, 45,919 bytes,
sha256 `6330d648…`. What follows stays as the record of what was submitted, and
as the template for the next version.*

---

## 1. Store listing

### Name
AI Chat QuickExport

### Summary (132 characters max — this one is 128)
Export full ChatGPT, Claude, Gemini & Grok conversations - text and images - as Markdown, JSON or one self-contained HTML file.

### Category
Productivity → Workflow & Planning

### Language
English

### Detailed description

**Export your AI conversations completely — every message, every turn, and the pictures too.**

AI Chat QuickExport reads your conversation the same way the page itself does, so you get the whole thing — including conversations with thousands of turns, where copy-paste and print give up.

**Supported platforms**

- **ChatGPT** — full history, including images and file attachments.
- **Claude** — full history, including images. (Non-image uploads are listed but cannot be downloaded; see "Known limits" below.)
- **Grok** — full history, including images you uploaded and images Grok generated for you, each with the prompt that made it.
- **Gemini** — text only, read from the page. Best effort; see "Known limits".

**Export formats**

- **Markdown (.md)** — clean, labelled, ready to read.
- **JSON** — structured data for processing.
- **HTML** — one self-contained page with the images embedded; double-click and it opens anywhere, offline, forever.

**Images and attachments**

A conversation that contains images exports as a .zip: the document plus an `assets/` folder. The filenames encode where each image sat in the conversation (`msg012-img1.png`), so a picture can always be matched back to the message it came from. Images are fetched one at a time with a live progress bar, so a conversation with hundreds of them exports as reliably as one with two. Text-only conversations still export as a single plain file.

**Also in this version**

- The popup tells you what it is pointed at *before* you click — platform and conversation name — so you never discover you exported the wrong tab afterwards.
- The filename you typed and the last result are remembered per conversation, so dismissing the popup does not cost you your place.
- Custom speaker labels: name the two voices whatever you like.

**Known limits — stated up front, because finding them yourself is worse**

- **Gemini is best effort.** Google offers no clean conversation API, so Gemini is read from the rendered page. That means: text only (no image export), long conversations must be scrolled to the top first so every turn is actually in the page, and a Google front-end redesign can break it without warning. It is included because a text transcript is better than none — not because it is on par with the other three.
- **Grok media coverage may be incomplete.** Grok's conversation format is undocumented and has changed more than once. Every shape this version handles was measured against live conversations: uploaded files, generated-image cards, and web-search image cards. A shape we have not seen yet may still export as text without its picture. If that happens, the export says so rather than quietly dropping it.
- **Images that Grok returned from a web search are exported as links, not files.** They are other people's pictures on other people's sites; bundling them would mean asking for permission to read every website you visit, which this extension will never do. The export keeps the title, the source site and both links.
- **Claude non-image uploads cannot be retrieved.** Documents you uploaded into Claude are stored in a form the site does not serve back; the export names them honestly instead of pretending they failed to download.

**Privacy**

No accounts, no servers, no analytics, no tracking. The conversation is read in your browser and written to your disk. Nothing is sent anywhere. Full policy: https://ethbuilds-dev.github.io/ai-chat-quickexport/privacy.html

### Privacy policy URL
https://ethbuilds-dev.github.io/ai-chat-quickexport/privacy.html

### Support / homepage URL
https://ethbuilds-dev.github.io/ai-chat-quickexport/

### Screenshots (1280×800, in `screenshots/store/`)
1. `store-1-popup.png` — the popup, with the line naming the conversation it is pointed at.
2. `store-2-markdown.png` — a Markdown export, open.
3. `store-3-assets.png` — the .zip opened: the document beside `assets/msg002-img1`.
4. `store-4-html.png` — the self-contained HTML, images in place.
5. `store-5-formats.png` — the save moment: the three format buttons, the result line ("Exported 153 messages + 20 images embedded"), and the Save-As dialog carrying the typed filename unchanged.

---

## 2. Privacy practices tab

### Single purpose (one sentence, as the field requires)

AI Chat QuickExport does one thing: it saves the conversation you are currently viewing on a supported AI platform to a local file, in Markdown, JSON or HTML.

### Permission justifications

**`activeTab`**
Used to read the URL and title of the tab you are on, at the moment you click the extension, in order to identify which platform and which conversation to export and to show you its name before you commit. No other tab is ever read.

**`scripting`**
Two uses, both scoped to the conversation tab you clicked from, and both only while an export runs. (1) The conversation itself: ChatGPT and Gemini are read from inside the page — ChatGPT because its servers reject an identical request made from the extension's background context, Gemini because there is no API and the transcript exists only as rendered DOM. (2) ChatGPT image data: its image URLs are signed and only honoured for a request originating in the page. Nothing is injected into pages you have not asked to export, and no script persists after the export finishes.

**`storage`**
Two small records, both local to your browser, both yours. Sync storage keeps the two speaker labels you choose (e.g. "USER" / "ASSISTANT"). Local storage keeps, per conversation, the filename you last typed and the last success message, so reopening the popup does not lose your place; those records are capped at the 200 most recent conversations and expire after 90 days. No conversation content is stored.

**Host permission — `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://claude.ai/*`, `https://gemini.google.com/*`, `https://grok.com/*`, `https://x.com/*`**
These are the platforms the extension exports from. Access is needed to read the conversation you asked for, using your existing logged-in session — the same session the page itself uses. The extension is inert on every other site.

**Host permission — `https://*.oaiusercontent.com/*`**
The host that serves ChatGPT's images and file attachments. Required to download the pictures in a conversation so they can be packed into the export beside it. Nothing is uploaded to this host.

**Host permission — `https://assets.grok.com/*`**
The host that serves the files you uploaded into a Grok conversation and the images Grok generated for you. Required for exactly the same reason as above, for the same kind of content, on Grok's side.

**Remote code**
None. The extension executes no remote code. All logic ships inside the package; nothing is fetched and evaluated at runtime. The only network requests it makes are data requests to the platforms listed above.

### Data usage — what is collected

**None of the disclosable categories apply.** The extension does not collect personally identifiable information, health information, financial information, authentication information, personal communications, location, web history, or user activity in the sense of the disclosure — nothing leaves the device, and there is no server to receive it.

The one thing worth stating plainly, even though the form has no box for it: the conversation you export **is** a personal communication, it is read in order to write it to your own disk, and it never travels anywhere else. Authentication tokens belonging to your existing platform session are held in memory for the duration of a single export request, are never written to disk, and are never transmitted anywhere except back to the platform they came from.

### Certifications (all three, truthfully)

- I do **not** sell or transfer user data to third parties, outside of approved use cases. *(There is no transfer at all.)*
- I do **not** use or transfer user data for purposes unrelated to the item's single purpose.
- I do **not** use or transfer user data to determine creditworthiness or for lending purposes.

---

## 3. What reviewers and users must be told about this update

**The new host permissions disable the extension on update until the user approves them.**
Between the published 1.4.0 and this 1.5.8, two host permissions are added — `*.oaiusercontent.com` and `assets.grok.com` — because image export is impossible without them. Chrome greys out an extension whose update requests new hosts until the user accepts, so **every existing user will see "needs permission" once, and must click it.** That is expected, not a fault, and it is said in the changelog and in the release notes so nobody thinks the extension broke.

**Version note for the listing's "What's new":**

> 1.5 exports the pictures too. A conversation with images now saves as a .zip — the document plus an `assets/` folder whose filenames say which message each image belonged to — or as one self-contained HTML page with the images embedded. Grok's uploaded and generated images are included, each generated one carrying its prompt. Because images live on separate hosts, this version asks for two new host permissions and Chrome will ask you to approve them once. Gemini remains text-only and best effort.

---

## 4. Submission checklist

- [x] Package built and verified from a clean unpack: `ai-chat-quickexport-v1.5.8.zip`, 9 files, every referenced file present, all four scripts parse, manifest version 1.5.8.
- [x] 206/206 unit checks, 53/53 adversarial attacks.
- [x] Field proof on a live 102-image conversation: `docs/v1.5-FIELD-PROOF-2026-08-22.md`.
- [x] Screenshots at exactly 1280×800, showing 1.5 behaviour (the 1.4 set showed two buttons and no images — it would have misrepresented the product).
- [x] Privacy policy page updated to match the actual permissions and the actual storage.
- [x] Known limits written in the listing, the README and the policy — not discovered by the user.
- [x] Uploaded to the dashboard, justifications pasted, submitted for review.
- [x] **Passed review and went live** — 2026-08-24, confirmed by the update
  service, which is the only source that speaks for what users actually get.

---

## 5. How to submit — the click path, so it is ten minutes and not an afternoon

**Blocked on one thing only: the dashboard sign-in.** The developer account is
`ethbuilds.dev@gmail.com` (Chrome profile "Ethan"), item id
`oocipcgmlmgnkkcodlnnpdddgmodhoai`. Attempted 2026-08-23, 02:5x: the Chrome
profile currently reachable from here is signed into three other Google accounts
and every one of them answers `chromewebstore` with *"To help keep your account
secure, Google needs to verify it's you — please sign in again."* A password is
required, and a password is not something this hand types. Everything below is
prepared so the part that needs a human is only the sign-in and the clicks.

1. **Sign in** to https://chrome.google.com/webstore/devconsole as
   `ethbuilds.dev@gmail.com`, and open the item **AI Chat QuickExport**.
2. **Package → Upload new package →** `ai-chat-quickexport-v1.5.8.zip`
   (md5 `13971c261a120bee5ae283ed507fa83b`, 42,843 bytes; the exact file attached
   to the GitHub release v1.5.8). The version field fills itself from the
   manifest: 1.5.8.
3. **Store listing tab** — paste from §1 above: the summary (128 chars), the
   detailed description, category *Productivity*, language *English*. Replace the
   five screenshots with `screenshots/store/store-1..5-*.png` (already exactly
   1280×800). Privacy policy URL and homepage URL are in §1.
4. **Privacy practices tab** — paste from §2, field by field: the single-purpose
   sentence, then one justification per permission (`activeTab`, `scripting`,
   `storage`, and the host permissions — the platform hosts share one box, the
   two asset hosts get their own), then the remote-code answer (**No**), then the
   data-collection section (**nothing is collected**), then tick all three
   certifications.
5. **Submit for review.** Then update the README line about the store from
   "packaged and queued" to submitted, with the date — after the click, not
   before.

*Review typically takes a few days; the most common cause of delay is exactly
what §2 exists to prevent — a missing or vague per-permission justification.*
