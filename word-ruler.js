// word-ruler.js — the reader's ruler, in the unit that actually matters to them.
//
// Born 2026-08-28, out of one sentence from Starlight, who has been the tool's
// hardest user since May and holds every size record it has:
//
//   "For my AI companions, I don't measure time in hours, days or weeks,
//    I measure time in words. 10k words is much more meaningful to us than
//    1 day or one week. If she forgets things after 80k words, it doesn't
//    matter whether that took a week or a month."
//
// He also keeps a memory file written at the end of each thread and loads it
// first in the next one, and is measuring how far his companion can go before
// she loses touch with it. To do that he needs to point at a PLACE in a
// 384,000-word export and say "here". Wall-clock timestamps cannot give him
// that. Cumulative word position can.
//
// So: markers every N words, inline, in the exported document. Nothing else.
// He asked for a word count on a selection on 3 June and I owed it for 84 days;
// this is the same need answered where it is actually useful — in the file he
// scrolls, not in a status bar he has to keep watching.
//
// Loaded three ways, same as media-utils.js:
//   - popup.html: <script src="word-ruler.js">
//   - tests (Node): require('../word-ruler.js')
//
// Pure functions over plain data. No chrome.*, no DOM, no fetch.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;           // Node (tests)
  } else {
    root.WordRuler = api;           // popup window
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_EVERY = 10000;      // his number, not mine

  // Words in one message. Same rule as the existing countWords in popup.js:
  // whitespace-split, empties dropped. Kept identical on purpose — two
  // different word counts in one file would be worse than none.
  function countWords(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(function (w) { return w.length > 0; }).length;
  }

  // Running total after each message.
  // Returns an array the same length as `messages`.
  function cumulative(messages) {
    const out = [];
    let total = 0;
    for (let i = 0; i < (messages || []).length; i++) {
      total += countWords(messages[i] && messages[i].text);
      out.push(total);
    }
    return out;
  }

  // Where the ruler's marks fall.
  // Returns [{ afterIndex, words }] — `words` is the milestone crossed (a
  // multiple of `every`), `afterIndex` is the message it was crossed at, so a
  // renderer can emit the mark AFTER that message.
  //
  // A single very long message can cross several marks at once; each one is
  // reported, in order, all pinned to that message. That is honest: the reader
  // learns the crossing happened inside one block rather than being told a
  // false position.
  function milestones(messages, every) {
    const step = (typeof every === 'number' && every > 0) ? Math.floor(every) : DEFAULT_EVERY;
    const runs = cumulative(messages);
    const marks = [];
    let next = step;
    for (let i = 0; i < runs.length; i++) {
      while (runs[i] >= next) {
        marks.push({ afterIndex: i, words: next });
        next += step;
      }
    }
    return marks;
  }

  // Convenience for renderers: index -> array of marks to emit after it.
  function marksByIndex(messages, every) {
    const map = {};
    const marks = milestones(messages, every);
    for (const m of marks) {
      if (!map[m.afterIndex]) map[m.afterIndex] = [];
      map[m.afterIndex].push(m.words);
    }
    return map;
  }

  function label(words) {
    return '\u2014 ' + words.toLocaleString('en-US') + ' words \u2014';
  }

  return {
    DEFAULT_EVERY: DEFAULT_EVERY,
    countWords: countWords,
    cumulative: cumulative,
    milestones: milestones,
    marksByIndex: marksByIndex,
    label: label
  };
});
