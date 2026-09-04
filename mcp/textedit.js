/**
 * §7 — text-based editing: resolve a spoken phrase to a time range.
 *
 * The editor says "everything before 'so what we did next'";
 * this turns that into seconds. Matching is on normalised word sequences, not
 * raw strings, because the transcript carries its own punctuation and
 * capitalisation and splits sentences where Adobe's model decided to.
 */

/** Strip punctuation/case so "Next." and "next," compare equal. */
const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, "")
    .trim();

export function flattenWords(transcript) {
  const words = [];
  for (const seg of transcript.segments || []) {
    for (const w of seg.words || []) words.push(w);
  }
  return words.sort((a, b) => a.start - b.start);
}

/**
 * Finds every occurrence of `phrase` in the transcript.
 *
 * Disfluency entries carry empty text and are skipped when matching, so a
 * filler in the middle of a sentence cannot break a phrase match — but they
 * stay in the underlying word list so the returned times remain true.
 */
export function findPhrase(transcript, phrase) {
  const words = flattenWords(transcript);
  const searchable = words
    .map((w, i) => ({ w, i, n: norm(w.text) }))
    .filter((x) => x.n.length > 0);

  const needle = norm(phrase).split(/\s+/).filter(Boolean);
  if (!needle.length) throw new Error("empty phrase");

  const hits = [];
  for (let i = 0; i + needle.length <= searchable.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (searchable[i + j].n !== needle[j]) { ok = false; break; }
    }
    if (!ok) continue;
    const first = searchable[i].w;
    const last = searchable[i + needle.length - 1].w;
    hits.push({
      start: first.start,
      end: last.start + last.duration,
      text: words
        .slice(searchable[i].i, searchable[i + needle.length - 1].i + 1)
        .map((w) => w.text)
        .filter(Boolean)
        .join(" "),
      wordIndex: searchable[i].i,
    });
  }
  return hits;
}

/**
 * The gap of silence before a phrase, so a cut can land in the silence rather
 * than hard against the first syllable. Returns the previous word's end and the
 * available room.
 */
export function silenceBefore(transcript, startSeconds) {
  const words = flattenWords(transcript);
  let prevEnd = 0;
  for (const w of words) {
    const e = w.start + w.duration;
    if (e <= startSeconds + 1e-9) prevEnd = Math.max(prevEnd, e);
  }
  return { previousWordEnd: prevEnd, gap: Number((startSeconds - prevEnd).toFixed(3)) };
}

/**
 * Picks a cut point just before a phrase: `preroll` seconds early, but never
 * back into the previous word.
 */
export function cutPointBefore(transcript, startSeconds, preroll = 0.15) {
  const { previousWordEnd, gap } = silenceBefore(transcript, startSeconds);
  const desired = startSeconds - preroll;
  const at = gap > 0 ? Math.max(previousWordEnd, desired) : startSeconds;
  return { at: Number(at.toFixed(3)), previousWordEnd, gap, preroll };
}

export function transcriptDuration(transcript) {
  return Math.max(...(transcript.segments || []).map((s) => s.start + s.duration));
}
