/**
 * §8 — the cleanup decision layer.
 *
 * Turns Premiere's own transcript into keep-ranges. Deliberately not a model
 * call: Premiere already tags fillers as "disfluency", and pauses are just
 * arithmetic on word gaps, so this stage is pure data and stays auditable
 * line by line.
 *
 * Everything is in SOURCE seconds, matching the transcript's own domain.
 */

/** Flattens segments into one time-ordered word list. */
export function flattenWords(transcript) {
  const words = [];
  for (const seg of transcript.segments || []) {
    for (const w of seg.words || []) words.push(w);
  }
  return words.sort((a, b) => a.start - b.start);
}

const end = (w) => w.start + w.duration;

/**
 * Spans to remove: disfluency-tagged words, and silence longer than
 * maxPauseSeconds. A trimmed pause keeps `keepPauseSeconds` of breathing room
 * rather than butting words together, which sounds unnatural.
 */
export function findCuts(words, opts = {}) {
  const {
    maxPauseSeconds = 1.0,
    keepPauseSeconds = 0.35,
    removeDisfluencies = true,
    padSeconds = 0.02,
  } = opts;

  const cuts = [];

  if (removeDisfluencies) {
    for (const w of words) {
      if ((w.tags || []).includes("disfluency")) {
        cuts.push({
          start: Math.max(0, w.start - padSeconds),
          end: end(w) + padSeconds,
          reason: "disfluency",
          text: w.text || "(untranscribed)",
        });
      }
    }
  }

  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - end(words[i]);
    if (gap > maxPauseSeconds) {
      // Trim from the middle so both sides keep a little air.
      const trimFrom = end(words[i]) + keepPauseSeconds / 2;
      const trimTo = words[i + 1].start - keepPauseSeconds / 2;
      if (trimTo > trimFrom) {
        cuts.push({
          start: trimFrom,
          end: trimTo,
          reason: "pause",
          gap: Number(gap.toFixed(2)),
          after: words[i].text,
          before: words[i + 1].text,
        });
      }
    }
  }

  return cuts.sort((a, b) => a.start - b.start);
}

/** Merges overlapping/adjacent cuts so inversion cannot produce zero-length keeps. */
export function mergeCuts(cuts, epsilon = 0.001) {
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + epsilon) {
      last.end = Math.max(last.end, c.end);
      last.reasons = [...new Set([...(last.reasons || [last.reason]), c.reason])];
    } else {
      merged.push({ ...c, reasons: [c.reason] });
    }
  }
  return merged;
}

/** Inverts cuts into the ranges to keep, clamped to [0, duration]. */
export function invertToKeepRanges(cuts, duration, minKeepSeconds = 0.25) {
  const keeps = [];
  let cursor = 0;
  for (const c of cuts) {
    const start = Math.max(0, c.start);
    if (start - cursor > minKeepSeconds) keeps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, Math.min(duration, c.end));
  }
  if (duration - cursor > minKeepSeconds) keeps.push({ start: cursor, end: duration });
  return keeps;
}

/** Full pipeline: transcript -> {cuts, keeps, stats}. */
export function planCleanup(transcript, duration, opts = {}) {
  const { maxCutSeconds = 4 } = opts;
  const words = flattenWords(transcript);
  const raw = findCuts(words, opts);

  // A long silence is usually deliberate picture — B-roll, a beat, a reaction.
  // The transcript cannot see the frame, so anything longer than maxCutSeconds
  // is held back for a human rather than removed on the strength of audio alone.
  const applied = [];
  const heldForReview = [];
  for (const c of raw) {
    if (c.end - c.start > maxCutSeconds) heldForReview.push(c);
    else applied.push(c);
  }

  const cuts = mergeCuts(applied);
  const keeps = invertToKeepRanges(cuts, duration, opts.minKeepSeconds);

  const removed = cuts.reduce((a, c) => a + (c.end - c.start), 0);
  const kept = keeps.reduce((a, k) => a + (k.end - k.start), 0);

  return {
    cuts,
    keeps,
    heldForReview,
    stats: {
      words: words.length,
      rawCuts: raw.length,
      heldForReview: heldForReview.length,
      mergedCuts: cuts.length,
      keepRanges: keeps.length,
      disfluencies: raw.filter((c) => c.reason === "disfluency").length,
      pauses: raw.filter((c) => c.reason === "pause").length,
      sourceDuration: Number(duration.toFixed(2)),
      removedSeconds: Number(removed.toFixed(2)),
      keptSeconds: Number(kept.toFixed(2)),
      removedPercent: Number(((removed / duration) * 100).toFixed(1)),
    },
  };
}
