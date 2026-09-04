/**
 * §7 — the source-time → sequence-time mapping layer.
 *
 * Premiere's transcript is attached to the SOURCE clip and its timings are in
 * source seconds. Edits happen in sequence time. Those two only coincide while
 * a clip sits at sequence 0 with a source in-point of 0 — which stops being
 * true the moment the agent makes its first cut.
 *
 * The brief hoped a sequence-level transcript would remove the need for this.
 * The API has no such thing (every Transcript method takes a ClipProjectItem),
 * so this layer is unavoidable.
 */

/** Clips of one track from a timeline dump, in sequence order. */
export function trackClips(dump, trackId = "V0") {
  const track = dump.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  return track.items
    .map((it) => ({
      seqStart: it.start.seconds,
      seqEnd: it.end.seconds,
      srcIn: it.inPoint.seconds,
      srcOut: it.outPoint.seconds,
      projectItemId: it.projectItemId,
    }))
    .sort((a, b) => a.seqStart - b.seqStart);
}

/**
 * Maps a source time to sequence time(s).
 *
 * Returns every occurrence: after cuts, one source instant may appear zero
 * times (it was removed) or several (the footage was used more than once), so
 * callers must handle both rather than assuming a single answer.
 */
export function sourceToSequence(dump, srcSeconds, trackId = "V0", projectItemId = null) {
  const hits = [];
  for (const c of trackClips(dump, trackId)) {
    if (projectItemId && c.projectItemId !== projectItemId) continue;
    if (srcSeconds >= c.srcIn - 1e-6 && srcSeconds <= c.srcOut + 1e-6) {
      hits.push({ seqTime: c.seqStart + (srcSeconds - c.srcIn), clip: c });
    }
  }
  return hits;
}

/** Convenience: exactly one mapping, or an explanatory error. */
export function sourceToSequenceOne(dump, srcSeconds, trackId = "V0", projectItemId = null) {
  const hits = sourceToSequence(dump, srcSeconds, trackId, projectItemId);
  if (!hits.length) throw new Error(`source time ${srcSeconds}s is not present in ${trackId}`);
  if (hits.length > 1) {
    throw new Error(
      `source time ${srcSeconds}s appears ${hits.length} times in ${trackId} — ambiguous, address by clip instead`
    );
  }
  return hits[0].seqTime;
}

/**
 * Maps source-time cut ranges into sequence time, dropping any that no longer
 * exist and reporting them rather than failing silently.
 */
export function mapCuts(dump, cuts, trackId = "V0", projectItemId = null) {
  const mapped = [];
  const skipped = [];
  for (const cut of cuts) {
    const a = sourceToSequence(dump, cut.start, trackId, projectItemId);
    const b = sourceToSequence(dump, cut.end, trackId, projectItemId);
    if (a.length !== 1 || b.length !== 1) {
      skipped.push({ ...cut, reason: `maps to ${a.length}/${b.length} places in the timeline` });
      continue;
    }
    // Compare by value, not identity: each sourceToSequence call rebuilds the
    // clip list, so object identity never matches even for the same clip.
    if (Math.abs(a[0].clip.seqStart - b[0].clip.seqStart) > 1e-6) {
      skipped.push({ ...cut, reason: "range straddles an existing cut" });
      continue;
    }
    mapped.push({ ...cut, seqStart: a[0].seqTime, seqEnd: b[0].seqTime });
  }
  // End-to-start: ripple shifts everything to the right of a cut, so applying
  // in reverse keeps the not-yet-applied coordinates valid (§5).
  mapped.sort((x, y) => y.seqStart - x.seqStart);
  return { mapped, skipped };
}
