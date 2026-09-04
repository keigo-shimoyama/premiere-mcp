# premierepro UXP API traps

Everything below was established empirically on Premiere **26.3.2**, package
`@adobe/premierepro@26.3.0`. None of it is in Adobe's documentation. The
chronology of the findings lives in [probe-results.md](probe-results.md); this
file is only the distilled "how to write it" version.

---

## 1. Object handles go stale

`The script object is no longer valid.` — an object obtained **before** an
`await` cannot be used to build an `Action` afterwards.

Go stale: **track items, SequenceEditor, TrackItemSelection, ProjectItem.**
Live longer: `Project`, `Sequence`, `VideoTrack` / `AudioTrack`.

The nastiest case is **`SequenceEditor`**: a stale handle does not throw, it
silently does nothing. The clone is simply never created, and you get `ok: true`.

**Rule:** acquire everything that goes stale **inside** `lockedAccess`.

Adobe enforces this: 26.3 tightened `create*Action()` to require locked state,
and `@adobe/eslint-plugin-premierepro` ships rules that flag construction
outside the lock, actions escaping their lock scope, and async callbacks passed
to `lockedAccess` / `executeTransaction`. Run `npm run lint` before believing a
failure here is a mystery — two entries in this file (§10, and the `trimHead`
regression) turned out to be this rule rather than staleness.

```js
project.lockedAccess(() => {
  const editor = ppro.SequenceEditor.getEditor(sequence);   // inside!
  const items = track.getTrackItems(CLIP, false);           // inside!
  const actions = items.filter(Boolean).map((it) => it.createMoveAction(t));
  project.executeTransaction((tx) => {
    for (const a of actions) tx.addAction(a);
  }, "agent: ...");
});
```

## 2. Addressing by index

`lockedAccess` takes a **synchronous** callback, while clip times are read
asynchronously (`getStartTime()`). So inside the lock there is no way to work
out which clip to touch.

But `getTrackItems()` is **synchronous**. Hence the pattern:

1. outside the lock, read the times and compute the **indices** of the clips
   you want;
2. inside `lockedAccess`, re-acquire `getTrackItems()` and take them by index.

Indices shift after every commit — re-read them each time.

## 3. `executeTransaction` does not roll back on an exception

If **building** one of the `Action`s throws inside the callback, the actions
already added **stay applied**. Atomicity covers only successfully built
actions.

**Rule: build every `Action` before opening the transaction.** Inside it, do
nothing but `addAction`.

## 4. Linked video and audio are two independent objects

`createSetEndAction` on a video clip **does not touch** the linked audio clip.
The response honestly returns `ok`, and the timeline stays broken.

The link is not expressed in the API. Detect it heuristically: same
`projectItem.getId()` plus matching start/end. Apply the actions to both **in
one transaction**.

## 5. `createMoveAction` — an offset validated against its result

The argument is an **offset**, not an absolute time. Negative values are
allowed.

But the action is validated **at build time**: `createMoveAction(-12.33)`
throws `Invalid parameter` if the clip still sits at 0 — the result would land
left of zero. Trim and move must be **separate transactions**, the second one
built from a fresh read.

## 5a. `createMoveAction` must not reorder clips past their neighbours

A move that changes the **chronological order** of clips on a track (A ending
up to the right of B) commits, and the dump confirms the new positions — but it
corrupts the project:

- the internal `getTrackItems()` list stops being sorted by time;
- the timeline UI shows holes where the model has a clip, scrubbing draws torn
  blocks, and zooming makes clips visually drift apart;
- the Program Monitor and `exportSequenceFrame` render a third state: white
  frames where the clip is, video where there is nothing;
- **the damage is saved into the `.prproj`** — reopening the project does not
  heal it.

Observed on a reorder done by "parking" (moving every segment right into free
space in target order, then closeGaps back left). Every move in its own
transaction, every position valid, no errors — and the project is broken. The
only move pattern observed to be safe is a shift that preserves relative order
(as closeGaps does).

**Rule: change segment order only by cloning and deleting the originals** (a
new clone is a new item, so the ordering invariant is never violated), or build
a new sequence. The only recovery from the corruption is a `.prproj` snapshot.

The working pattern (verified, `ppro_reorder`): clone the segments into free
space past the end of the timeline, already in target order -> delete the
originals without ripple -> `closeGaps` slides the block back to zero as one
collective shift (order preserved, therefore safe). Side effect: the renderer
keeps a **phantom of the parking zone** — scrubbing over the empty space past
the end of the timeline shows frames, and the ruler carries a yellow preview
bar. The model is clean (playback and export durations are correct); the
phantom should disappear when the project is reopened, since the preview cache
is not part of the `.prproj`.

## 5b. `createSetInPointAction` / `createSetOutPointAction` on a track item — do not use

The behaviour depends on hidden state and changes from call to call: sometimes
it moves only the source window (start/end stay, the content is swapped),
sometimes it rolls the clip edge along the timeline (start and inPoint
together), sometimes it silently clamps at zero (-89.5 s requested, -3 applied).
Afterwards the `getOutPoint()` getter starts returning garbage
(outPoint < inPoint), and the garbage propagates into the dump.

**Rule: set a clip's source window only through `createSetStartAction` /
`createSetEndAction`** — they move the timeline edge and the source point
strictly together (verified). The mapping is `src = t + (inPoint - start)`. The
source range you want is carved out arithmetically: clone into free space ->
setEnd -> setStart -> move into position.

Bonus: `createSetEndAction` can **extend** the tail beyond the cloned source
window as long as the media has material left (verified: a 12.9-21.5 window
stretched to out 34.5).

## 6. There is no razor or split in the API

Neither `createSplitAction` nor a razor exists. Verified by enumerating the
prototype chain at runtime — there are no hidden methods.

**There is, however, one documented way to make Premiere cut the timeline
itself**: `SequenceUtils.performSceneEditDetectionOnSelection(operation,
selection)` with `SEQUENCE_OPERATION_APPLYCUT`. Verified cutting on 26.3.2. It
does not replace the emulation below, because you cannot aim it — it cuts where
Premiere detects a scene change, not at a time you choose. Three constraints,
all observed live:

- **Video only.** Audio items are never cut, even when they are in the
  selection, so the linked pair ends up structurally divergent (§4).
- **Not idempotent.** A second run re-cuts material it already cut and leaves a
  one-frame sliver at the old cut point. Run it once, on undetected material.
- **Not a transaction.** Undo is not guaranteed; snapshot first.

Useful for rushes and stringouts of flattened exports. Useless for "cut at
12.4s" — that is what the emulation below is for.

**Emulating a cut** (`timeline.splitAt`):

```
[====== C ======]                        the original clip
[====== C ======]      [===== C' =====]  1. clone into FREE space at +F
[== C ==]              [====== C' ====]  2. original: createSetEndAction(at)
[== C ==]                     [== C' =]  3. clone:    createSetStartAction(at+F)
[== C ==][== C' =]                       4. clone:    createMoveAction(-F)
```

A clone at offset **0 is rejected** (two clips cannot occupy one range); a
clone into empty space works. `F = timeline_end + 10 s`.

The result is continuous both along the timeline and along the source.

## 7. Ripple delete leaves gaps

`createRemoveItemsAction(..., ripple = true, ...)` does not butt the clips
together: cut points snap to frames (0.01-0.05 s), and a gap of **0.93 s** has
been observed.

**Rule: run `timeline.closeGaps` after a series of edits** — it measures the
timeline and removes what is actually there rather than what should have
resulted.

## 8. `getTrackItems(EMPTY, true)` does not return gaps

Empty intervals never arrive through this call; sometimes `null`s do, and they
have to be filtered out (`if (!it) continue`). A ripple delete on a gap element
cannot be built — gaps are closed by shifting clips instead.

## 9. `createSequence()` takes the default preset

A 1080x1920 source gives you a 1920x1080 sequence. Silently.

**Rule: use `sequence.createCloneAction()` only** — it inherits every setting
of the original. Check `settingsMatch` afterwards.

## 10. Do not create project items

Subclips (`createSubClipAction`) bloat the project and break Collect & Share.
Make edits **in place, in a duplicate of the sequence** — track item clones
reference the same footage.

**Resolved, 2026-09-04.** `FolderItem.createRemoveItemAction()` was recorded
here as failing with `The script object is no longer valid.` — read as a stale
handle. It was not: the action was being **built outside `lockedAccess`**, which
26.3 forbids (§1). Fetch the items with the async `getItems()` outside, then
build the actions inside the lock, awaiting nothing in between. Verified live:
a scratch sequence's project item was removed and the read-back list came back
empty. Adobe's lint rule finds this class of bug statically.

## 11. The transcript belongs to the source, not the sequence

Every `Transcript` method takes a `ClipProjectItem`. `Sequence` has no
transcript methods at all. A `source time -> sequence time` mapping layer is
mandatory — see [mcp/timemap.js](../mcp/timemap.js).

Transcript timings are in **source seconds**. Edits are in timeline seconds.
They coincide only while the clip sits at 0 with `srcIn = 0`, i.e. until the
very first edit.

**Correction, 2026-09-04.** The statement above holds for the `Sequence` *type*,
but not for the project. A sequence also has a **project item**, and Premiere can
attach a transcript to it: on a 40-clip sequence, `exportToJSON` on the
sequence's own project item returned 40 segments, 40 speakers and 711 words
whose last word ends at 256.87 s — exactly the sequence duration. That transcript
is in **timeline time**, so where one exists the mapping layer is not needed.

It has to be requested in Premiere (Text panel -> Transcribe, with the sequence
selected), and it **follows the edits**: after `trimHead(3.0)` on a duplicate the
sequence transcript came back with 697 words instead of 711, ending at 253.87 s
(the new duration), its first word being the one that previously sat at 3.12 s.
It is a live view of the timeline, not a snapshot taken at transcription time.

A duplicate inherits it, so `ppro_sequence_duplicate` carries the transcript into
the working copy.

Where a sequence transcript exists, edits can be planned directly in timeline
seconds and re-read after every batch — no `source -> sequence` mapping at all.
[mcp/timemap.js](../mcp/timemap.js) remains the path for clip-level transcripts,
which is what you get when the sequence has never been transcribed.

## 12. `Application.version` does not work

`ppro.Application.version` returns `undefined`.
The working source is `require("uxp").host.version`.

## 13. A command's reply is not proof

Twice in a row `ok: true` came back for an operation that left the timeline
broken (unlinked audio; gaps left open).

**Rule: after every batch, re-read the state and compare it against what was
expected.** The invariant applies on the way out, not only on the way in.
