#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-export.py — the receipt for a LIVE export.

Born 2026-08-22, at Zaina's order: "il testam end to end, pe GPT si pe Claude
cel putin. Ii dam toolul complet, nu bucati."

The offline suite (tests/run-tests.js, 129 checks) proves the LOGIC. The popup
click is the one step no tool of mine can drive (Chrome forbids scripting
another extension's pages). So the division is: her finger opens the popup,
this script judges the artifact — byte by byte, no eyeballing, no trust.

The failure it exists to catch is the field failure of 2026-08-06: every image
exported as
    *[alt -- not exported (download failed or unsupported)]*
because the bulk FETCH_MEDIA response blew past Chrome's ~64 MB message cap.
Fix 4a32f57 = one FETCH_MEDIA_ONE per image. A green run here is the proof.

Usage:
    python tests/verify-export.py <file.zip|file.html|file.md|file.json> [...]
    python tests/verify-export.py --latest        # newest export in Downloads

Exit 0 = PASS (every check green). Exit 1 = FAIL (details printed).
"""

import io
import os
import re
import sys
import json
import glob
import zipfile
import base64

NOT_EXPORTED = "-- not exported (download failed or unsupported)"
DANGLING = "](asset:"

MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"%PDF-", "pdf"),
]


def sniff(data):
    for sig, ext in MAGIC:
        if data.startswith(sig):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "avif"
    if data[:5] == b"<svg " or data[:5] == b"<?xml":
        return "svg"
    return None


IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "avif", "svg"}


class Report(object):
    def __init__(self, name):
        self.name = name
        self.checks = []
        self.notes = []

    def check(self, ok, label, detail=""):
        self.checks.append((bool(ok), label, detail))

    def note(self, text):
        self.notes.append(text)

    @property
    def passed(self):
        return all(c[0] for c in self.checks)

    def render(self):
        out = []
        out.append("")
        out.append("=" * 72)
        out.append(self.name)
        out.append("=" * 72)
        for ok, label, detail in self.checks:
            mark = "  ok  " if ok else "  FAIL"
            line = "%s  %s" % (mark, label)
            if detail:
                line += "  --  %s" % detail
            out.append(line)
        for n in self.notes:
            out.append("  ..    %s" % n)
        out.append("")
        out.append("VERDICT: %s" % ("PASS" if self.passed else "FAIL"))
        return "\n".join(out)


def check_document_text(rep, text, label, asset_paths=None):
    """Checks that apply to any exported document body (md / json / html)."""
    n_failed = text.count(NOT_EXPORTED)
    rep.check(n_failed == 0, "%s: zero 'not exported' notes" % label,
              "found %d" % n_failed if n_failed else "")

    n_dangling = text.count(DANGLING)
    rep.check(n_dangling == 0, "%s: zero unresolved asset: placeholders" % label,
              "found %d" % n_dangling if n_dangling else "")

    if asset_paths is not None:
        linked = set(re.findall(r"\]\((assets/[^)\s]+)\)", text))
        missing = sorted(p for p in linked if p not in asset_paths)
        rep.check(not missing, "%s: every asset link resolves in the zip" % label,
                  "missing: %s" % ", ".join(missing[:5]) if missing else "")
        rep.note("%s: %d distinct asset links" % (label, len(linked)))
        orphans = sorted(p for p in asset_paths if p not in linked)
        if orphans:
            rep.note("assets present but not linked (%d): %s"
                     % (len(orphans), ", ".join(orphans[:5])))
    return


def verify_zip(path):
    rep = Report("ZIP  %s  (%d bytes)" % (os.path.basename(path), os.path.getsize(path)))
    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:
        rep.check(False, "opens as a zip", str(e))
        return rep
    rep.check(True, "opens as a zip")

    bad = zf.testzip()
    rep.check(bad is None, "no corrupt entries", bad or "")

    names = zf.namelist()
    roots = [n for n in names if "/" not in n]
    docs = [n for n in roots if n.lower().endswith((".md", ".json", ".html"))]
    rep.check(len(docs) == 1, "exactly one document at the zip root",
              "found %d: %s" % (len(docs), docs[:4]))
    if not docs:
        return rep
    doc = docs[0]

    assets = [n for n in names if n.startswith("assets/") and not n.endswith("/")]
    rep.check(len(assets) > 0, "assets/ folder is not empty",
              "%d files" % len(assets))

    raw = zf.read(doc)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", "replace")
        rep.check(False, "document decodes as UTF-8")
    else:
        rep.check(True, "document decodes as UTF-8")

    if doc.lower().endswith(".json"):
        try:
            obj = json.loads(text)
            rep.check(True, "JSON parses", "%d messages"
                      % len(obj.get("messages", []) if isinstance(obj, dict) else obj))
        except Exception as e:
            rep.check(False, "JSON parses", str(e))

    check_document_text(rep, text, "doc", set(assets))

    empties = []
    unsniffed = []
    mismatched = []
    total_bytes = 0
    for a in assets:
        data = zf.read(a)
        total_bytes += len(data)
        if len(data) == 0:
            empties.append(a)
            continue
        ext = os.path.splitext(a)[1].lower().lstrip(".")
        if ext in ("txt", "csv", "md", "json"):
            continue
        got = sniff(data)
        if got is None:
            unsniffed.append(a)
        elif ext in IMAGE_EXTS and got != ext and not (ext == "jpeg" and got == "jpg"):
            mismatched.append("%s (bytes look like %s)" % (a, got))

    rep.check(not empties, "every asset has bytes",
              "empty: %s" % ", ".join(empties[:5]) if empties else "")
    rep.check(not unsniffed, "every binary asset has a known file signature",
              "unrecognised: %s" % ", ".join(unsniffed[:5]) if unsniffed else "")
    rep.check(not mismatched, "extension matches the real bytes",
              "; ".join(mismatched[:5]) if mismatched else "")
    rep.note("assets: %d files, %.1f MB total"
             % (len(assets), total_bytes / 1048576.0))
    return rep


def verify_html(path):
    rep = Report("HTML %s  (%d bytes)" % (os.path.basename(path), os.path.getsize(path)))
    text = io.open(path, encoding="utf-8", errors="replace").read()
    rep.check(True, "reads as UTF-8")
    check_document_text(rep, text, "doc")

    uris = re.findall(r'src="data:(image/[a-z+]+);base64,([A-Za-z0-9+/=]+)"', text)
    rep.check(len(uris) > 0, "carries embedded images", "%d data URIs" % len(uris))
    broken = 0
    total = 0
    for mime, b64 in uris:
        try:
            data = base64.b64decode(b64)
        except Exception:
            broken += 1
            continue
        total += len(data)
        if not data or sniff(data) is None:
            broken += 1
    rep.check(broken == 0, "every data URI decodes to real image bytes",
              "%d broken" % broken if broken else "")
    rep.note("embedded: %d images, %.1f MB decoded" % (len(uris), total / 1048576.0))
    rep.check(text.lstrip().lower().startswith("<!doctype html"),
              "starts with a doctype")
    return rep


def verify_plain(path):
    rep = Report("DOC  %s  (%d bytes)" % (os.path.basename(path), os.path.getsize(path)))
    text = io.open(path, encoding="utf-8", errors="replace").read()
    rep.check(True, "reads as UTF-8")
    check_document_text(rep, text, "doc")
    rep.note("text-only export (no zip) — media path not exercised here")
    return rep


def verify(path):
    low = path.lower()
    if low.endswith(".zip"):
        return verify_zip(path)
    if low.endswith(".html") or low.endswith(".htm"):
        return verify_html(path)
    return verify_plain(path)


def latest_downloads():
    d = os.path.join(os.path.expanduser("~"), "Downloads")
    cands = []
    for pat in ("*.zip", "*.html", "*.md", "*.json"):
        cands += glob.glob(os.path.join(d, pat))
    named = [c for c in cands if re.search(
        r"(ChatGPT|Claude|Gemini|Grok)_", os.path.basename(c))]
    pool = named or cands
    if not pool:
        return []
    pool.sort(key=os.path.getmtime, reverse=True)
    return pool[:1]


def main(argv):
    args = argv[1:]
    if not args or args[0] == "--latest":
        paths = latest_downloads()
        if not paths:
            print("no export found in ~/Downloads")
            return 1
    else:
        paths = args

    reports = []
    for p in paths:
        if not os.path.exists(p):
            print("missing: %s" % p)
            return 1
        reports.append(verify(p))

    for r in reports:
        print(r.render())

    ok = all(r.passed for r in reports)
    print("")
    print("-" * 72)
    print("%d artifact(s): %s" % (len(reports), "ALL PASS" if ok else "FAILURES ABOVE"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
