/**
 * MCP server exposing the Premiere panel as tools.
 *
 * Reads, probes and MUTATES: most tools here edit the active sequence in place.
 * The composite ones — ppro_cleanup_apply, ppro_reorder, ppro_apply_cutlist —
 * snapshot the .prproj before touching anything; the primitives do not, so a
 * caller stringing them together should take a ppro_snapshot_create first. That
 * matters because some API failure modes corrupt a project past saving and
 * reopening, and the snapshot is then the only way back (docs/api-traps.md §5a).
 *
 * Planning, time mapping and orchestration live on this side rather than in the
 * panel, where they can change without reloading the plugin.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProxyClient } from "./client.js";
import { createSnapshot, listSnapshots, restoreSnapshot } from "./snapshot.js";
import { planCleanup } from "./cleanup.js";
import { findPhrase, cutPointBefore, transcriptDuration } from "./textedit.js";
import { mapCuts } from "./timemap.js";

const proxy = new ProxyClient();
const server = new McpServer({ name: "premiere-mcp", version: "0.1.0" });

/** Wraps a panel command as an MCP tool with uniform error reporting. */
function relay(name, config, command, mapArgs = (a) => a) {
  server.registerTool(name, config, async (args = {}) => {
    try {
      const result = await proxy.call(command, mapArgs(args));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `${command} failed: ${e.message}` }] };
    }
  });
}

relay("ppro_echo", {
  title: "Echo",
  description:
    "Round-trip check: sends a message through the proxy to the UXP panel inside Premiere and returns it with the app version. Use this to confirm the connection before anything else.",
  inputSchema: { message: z.string().describe("Text to echo back") },
}, "echo");

relay("ppro_env", {
  title: "Environment and feature detection",
  description:
    "Reports Premiere's version, the active project and sequence, and which API surfaces actually exist at runtime (transaction support, transcription trigger, frame export). Use this to tell the 26.3 stable channel from the 26.5 beta.",
  inputSchema: {},
}, "env");

server.registerTool("ppro_panel_reload", {
  title: "Reload Premiere panel",
  description: "Reloads the UXP panel after its reply, waits for reconnection, and resets its transaction counter.",
  inputSchema: {},
}, async () => {
  try {
    const before = await proxy.call("panel_reload");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const env = await proxy.call("env");
      if (env.panel?.loadedAt !== before.loadedAtBefore) {
        return { content: [{ type: "text", text: JSON.stringify({ reloaded: true, txCountBefore: before.txCountBefore }) }] };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("panel did not reconnect within 15 seconds");
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `panel_reload failed: ${e.message}` }] };
  }
});

relay("ppro_timeline_dump", {
  title: "Dump timeline",
  description:
    "Read-only structural dump of the active sequence: every track, every clip with in/out/start/end times, source, enabled state, and a synthesized stable key. This is the text representation of the timeline — prefer it over any screenshot.",
  inputSchema: {},
}, "timeline.dump");

relay("ppro_selection", {
  title: "Get selection and playhead",
  description:
    "Returns the clips currently selected in the timeline plus the playhead position — i.e. what the editor is actually looking at when they say 'remove this'.",
  inputSchema: {},
}, "selection.get");

relay("ppro_debug_arity", {
  title: "Probe undocumented editor methods",
  description:
    "Reports the arity of every SequenceEditor method, including createAddItemAction/createAddItemsAction which exist at runtime but are in no published declarations.",
  inputSchema: {},
}, "debug.arity");

relay("ppro_debug_invoke", {
  title: "Invoke an API method reflectively",
  description:
    "Calls a method on a resolved API object and reports what came back, for exploring undocumented bindings. Cannot commit a transaction, so create*Action calls build an Action without mutating the project.",
  inputSchema: {
    target: z.enum(["trackItem", "sequenceEditor", "sequence", "project", "transcript", "exporter"]),
    on: z.object({ track: z.string(), index: z.number().int().nonnegative() }).optional()
      .describe('Which clip, when target is "trackItem"'),
    method: z.string(),
    args: z.array(z.any()).optional().describe("Args; objects may use $seconds/$ticks/$trackItem/$projectItemId/$selection/$liveSelection/$const directives. Arrays are resolved element-wise."),
    lockedAccess: z.boolean().optional().describe("Wrap the call in project.lockedAccess(), required by some bindings"),
  },
}, "debug.invoke");

relay("ppro_transcript_probe", {
  title: "Probe transcript schema",
  description:
    "Scans project items for transcripts and dumps the JSON schema of the first one found. Answers whether Premiere's transcript carries word-level timings or only segment-level.",
  inputSchema: {
    clipId: z.string().optional().describe("Project item id to read the transcript from; defaults to the first item that has one"),
    headBytes: z.number().int().positive().max(200000).optional()
      .describe("How many bytes of raw transcript JSON to include (default 3000)"),
  },
}, "transcript.probe");

relay("ppro_sequence_list", {
  title: "List sequences",
  description: "Lists every sequence with its frame size and which one is active. Use it to confirm an agent-made sequence matches the original's format.",
  inputSchema: {},
}, "sequence.list");

relay("ppro_sequence_duplicate", {
  title: "Duplicate a sequence and work in the copy",
  description:
    "Clones a sequence, inheriting frame size, frame rate and all settings from the original, then activates the copy. Prefer this over building a new sequence: createSequence uses the default preset and will silently give 16:9 for vertical footage.",
  inputSchema: { guid: z.string().optional().describe("Sequence to duplicate; defaults to the active one") },
}, "sequence.duplicate");

relay("ppro_close_gaps", {
  title: "Close gaps between clips",
  description:
    "Shifts later clips left until no gaps remain. Ripple delete leaves frame-snap residue and occasionally larger holes, so this measures the timeline and removes what is actually there.",
  inputSchema: {
    toleranceSeconds: z.number().optional().describe("Gaps smaller than this are ignored (default 0.001)"),
    maxPasses: z.number().int().positive().optional(),
  },
}, "timeline.closeGaps");

relay("ppro_remove_at", {
  title: "Remove the clip at a time",
  description:
    "Removes clips covering a sequence time. With ripple true the rest shifts left to close the gap. Combined with ppro_split_at this removes a span from the middle of a clip. MUTATES the active sequence.",
  inputSchema: {
    atSeconds: z.number(),
    ripple: z.boolean().optional().describe("Close the gap afterwards (default true)"),
    onlyTrack: z.string().optional().describe('Remove only the clip on this track, e.g. "V1" — for B-roll, without touching the dialogue underneath'),
    shiftOverlapping: z.boolean().optional().describe("Undocumented 4th arg of createRemoveItemsAction (default false); semantics under probe"),
  },
}, "timeline.removeAt");

relay("ppro_move_at", {
  title: "Move the clips at a time by an offset (order-preserving ONLY)",
  description:
    "Shifts every clip covering a sequence time by an offset, across all tracks in one transaction so linked A/V travels together. DANGER (api-traps §5a): a move that changes the chronological ORDER of clips on a track commits cleanly but corrupts the project — UI, renderer and API model diverge, and the damage survives saving. Only use for shifts that keep every clip on the same side of its neighbours. To RELOCATE a segment use ppro_reorder, which clones instead of moving. MUTATES the active sequence.",
  inputSchema: {
    atSeconds: z.number().describe("Sequence time covered by the clips to move"),
    bySeconds: z.number().describe("Offset in seconds; positive moves right"),
  },
}, "timeline.moveAt");

relay("ppro_clone_at", {
  title: "Clone the clips at a time to an offset",
  description:
    "Clones every clip covering a sequence time by an offset into FREE space, across all tracks in one transaction so a linked A/V pair is cloned together. A clone is a new track item, so this never violates the track's chronological order invariant the way a move can. The clone references the same footage — no new project items are created. onlyTrack + videoTrackOffset clones a single video item onto a higher track (video-only, B-roll style).",
  inputSchema: {
    atSeconds: z.number().describe("Sequence time covered by the clips to clone"),
    bySeconds: z.number().describe("Offset in seconds for the clone; the target range must be empty"),
    onlyTrack: z.string().optional().describe('Clone only the item on this track, e.g. "V0"'),
    videoTrackOffset: z.number().int().optional().describe("Vertical offset for video clones: V0 + 1 lands on V1 (default 0)"),
    audioTrackOffset: z.number().int().optional().describe("Vertical offset for audio clones (default 0)"),
  },
}, "timeline.cloneAt");

relay("ppro_retrim", {
  title: "Retrim one clip (timeline edges and/or source in/out)",
  description:
    "Adjusts a single clip addressed by track and index: timeline start/end (createSetStart/EndAction) and source in/out point (createSetInPoint/OutPointAction), all in one transaction. Reports before/after so the undocumented in/out semantics are verified rather than assumed. Does NOT touch the linked counterpart — pair it manually. MUTATES the active sequence.",
  inputSchema: {
    track: z.string().describe('Track id, e.g. "V1"'),
    index: z.number().int().nonnegative().optional().describe("Clip index on the track (default 0)"),
    startSeconds: z.number().optional().describe("New timeline start (trims the head)"),
    endSeconds: z.number().optional().describe("New timeline end (trims the tail)"),
    inPointSeconds: z.number().optional().describe("New source in point"),
    outPointSeconds: z.number().optional().describe("New source out point"),
  },
}, "timeline.retrim");

relay("ppro_split_at", {
  title: "Split clips at a time",
  description:
    "Splits every clip crossing a sequence time, by cloning into free track space, trimming both halves and sliding the copy back. This is the razor the UXP API does not provide. MUTATES the active sequence.",
  inputSchema: { atSeconds: z.number().describe("Sequence time to cut at") },
}, "timeline.splitAt");

relay("ppro_trim_head", {
  title: "Remove everything before a time",
  description:
    "Trims the head off every clip spanning the given sequence time and shifts them back to the origin, closing the gap. Video and audio move together in one transaction. MUTATES the active sequence — duplicate first.",
  inputSchema: { atSeconds: z.number().describe("Everything before this sequence time is removed") },
}, "timeline.trimHead");

relay("ppro_remove_items", {
  title: "Remove agent scratch project items",
  description: "Deletes project items whose name starts with a prefix. For cleaning up subclips or other scratch items the agent created.",
  inputSchema: { prefix: z.string().describe('Name prefix, e.g. "agent_"') },
}, "project.removeItems");

relay("ppro_sequence_rename", {
  title: "Rename a sequence",
  description: "Renames a sequence via its project item's createSetNameAction (Sequence itself has no rename). Defaults to the active sequence.",
  inputSchema: {
    name: z.string().describe("New sequence name"),
    guid: z.string().optional().describe("Sequence to rename; defaults to the active one"),
  },
}, "sequence.rename");

relay("ppro_capabilities", {
  title: "Probe what this Premiere host can actually do",
  description:
    "Reports which newer or undocumented API surfaces exist in the connected host: scene-edit detection and its operation constants, the Markers statics, track mute, track-item speed accessors, project import and preset-based sequence creation. Package version and TypeScript declarations are not evidence — the same declarations ship to hosts that lack the binding, so check here before relying on any of these.",
  inputSchema: {},
}, "capabilities.get");

relay("ppro_scene_detect", {
  title: "Run Premiere's scene-edit detection",
  description:
    "Runs Premiere's own scene-edit detection over a selection and has it apply cuts, drop markers, or make subclips. Cuts land where Premiere DETECTS a scene change — this is not a razor you can aim, so use ppro_split_at to cut at a chosen time. Verified on 26.3.2: only VIDEO items are cut even when audio is selected, leaving the linked pair structurally divergent; and the operation is NOT idempotent — a second run re-cuts material it already cut and leaves one-frame slivers, which the result reports. DIRECT HOST OPERATION, not a transaction: undo is not guaranteed, so take ppro_snapshot_create first and run it once, on undetected material. MUTATES the active sequence.",
  inputSchema: {
    operation: z.enum(["cuts", "markers", "subclips"]).optional()
      .describe("What detection produces (default cuts)"),
    track: z.string().optional().describe('Select every clip on this track, e.g. "V0", instead of using the timeline selection'),
    tracks: z.array(z.string()).optional()
      .describe('Several tracks, e.g. ["V0","A0"] — detection cuts only what is selected, so pass the linked audio track too or the pair ends up structurally divergent'),
    index: z.number().int().nonnegative().optional().describe("With track/tracks: select only this clip index"),
  },
}, "scene.detect");

relay("ppro_markers_list", {
  title: "List sequence markers",
  description: "Read-only list of the markers on the active sequence with guid, name, type, start and comments.",
  inputSchema: {},
}, "markers.list");

relay("ppro_marker_add", {
  title: "Add a sequence marker",
  description:
    "Adds a marker to the active sequence in one transaction and verifies it by re-reading the marker list. Useful for handing review points back to the editor rather than mutating their cut.",
  inputSchema: {
    name: z.string().describe("Marker name"),
    atSeconds: z.number().optional().describe("Sequence time (default 0)"),
    durationSeconds: z.number().optional().describe("Marker duration; 0 makes it a point marker"),
    comments: z.string().optional(),
    type: z.string().optional().describe("Marker type constant; defaults to Comment"),
  },
}, "markers.add");

relay("ppro_markers_remove", {
  title: "Remove sequence markers",
  description: "Removes markers by guid (or all of them) in one transaction, verified by re-counting. Pair it with ppro_markers_list to clean up review markers the agent left behind.",
  inputSchema: {
    guid: z.string().optional().describe("Single marker guid"),
    guids: z.array(z.string()).optional().describe("Several marker guids"),
    all: z.boolean().optional().describe("Remove every marker on the active sequence"),
  },
}, "markers.remove");

relay("ppro_track_mute", {
  title: "Mute or unmute a track",
  description: "Sets a track's mute flag and reads it back. Not a transaction — this is player state, not project state.",
  inputSchema: {
    track: z.string().optional().describe('Track id, e.g. "A0" (default A0)'),
    muted: z.boolean().optional().describe("Default true"),
  },
}, "track.setMute");

relay("ppro_sequence_delete", {
  title: "Delete a sequence",
  description: "Removes a sequence from the project. Intended for cleaning up agent scratch sequences.",
  inputSchema: {
    guid: z.string().optional(),
    name: z.string().optional().describe("Name, if no guid given"),
  },
}, "sequence.delete");

relay("ppro_grab_frame", {
  title: "Grab a frame from the Program Monitor",
  description:
    "Renders one frame of the composite at a given sequence time to a PNG. Shows effects, graphics and colour as the viewer sees them, which no ffmpeg read of the source can. Does not move the playhead.",
  inputSchema: {
    atSeconds: z.number().describe("Sequence time to capture"),
    dir: z.string().describe("Absolute directory to write into"),
    filename: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  },
}, "monitor.grabFrame");

relay("ppro_trim", {
  title: "Trim a clip's end",
  description:
    "Moves a clip's end point to the given sequence time. MUTATES the project. Re-reads the clip afterwards and reports before/after so the result is verified rather than assumed.",
  inputSchema: {
    track: z.string().optional().describe('Track id, e.g. "V0" (default V0)'),
    index: z.number().int().nonnegative().optional().describe("Clip index (default 0)"),
    atSeconds: z.number().describe("Sequence time the clip should end at"),
    includeLinked: z.boolean().optional().describe("Also trim the linked A/V counterpart (default true) — Premiere does NOT do this for you"),
  },
}, "timeline.trim", (a) => ({ track: a.track ?? "V0", index: a.index ?? 0, atSeconds: a.atSeconds, includeLinked: a.includeLinked }));

relay("ppro_project_save", {
  title: "Save the project",
  description: "Asks Premiere to save, so a snapshot captures the on-screen state rather than the last save point.",
  inputSchema: {},
}, "project.save");

server.registerTool("ppro_snapshot_create", {
  title: "Snapshot the project file",
  description:
    "Copies the active .prproj to snapshots/. This is the rollback unit for one agent turn — independent of Premiere's undo stack. Saves the project first so the snapshot reflects on-screen state.",
  inputSchema: { label: z.string().optional().describe("Short label for the snapshot filename") },
}, async ({ label }) => {
  try {
    const saved = await proxy.call("project.save", {});
    if (!saved.path) throw new Error("project has never been saved to disk — save it once in Premiere first");
    const out = await createSnapshot(saved.path, label || "turn");
    return { content: [{ type: "text", text: JSON.stringify({ ...out, project: saved.path }, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `snapshot failed: ${e.message}` }] };
  }
});

server.registerTool("ppro_snapshot_list", {
  title: "List snapshots",
  description: "Lists project snapshots, newest first.",
  inputSchema: {},
}, async () => {
  const out = await listSnapshots();
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
});

server.registerTool("ppro_snapshot_restore", {
  title: "Restore a snapshot",
  description:
    "Overwrites the project file with a snapshot. The project MUST be closed in Premiere first, or Premiere will write its in-memory copy back over it. The pre-restore state is itself backed up.",
  inputSchema: {
    snapshot: z.string().describe("Path to the snapshot file"),
    projectPath: z.string().describe("Absolute path of the .prproj to overwrite"),
  },
}, async ({ snapshot, projectPath }) => {
  try {
    const out = await restoreSnapshot(snapshot, projectPath);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `restore failed: ${e.message}` }] };
  }
});

/** Shared: fetch and parse a project item's transcript via the panel. */
async function fetchTranscript(clipId) {
  const probe = await proxy.call("transcript.probe", { clipId, headBytes: 200000 });
  if (!probe.head) throw new Error(probe.note || "no transcript available on that item");
  return { transcript: JSON.parse(probe.head), probe };
}

/** Shared: pull a transcript from the panel and turn it into a plan. */
async function buildPlan(args) {
  const probe = await proxy.call("transcript.probe", {
    clipId: args.clipId,
    headBytes: 200000,
  });
  if (!probe.head) throw new Error(probe.note || "no transcript available on that item");
  const transcript = JSON.parse(probe.head);
  const duration = Math.max(...transcript.segments.map((s) => s.start + s.duration));
  return {
    source: probe.source,
    clips: probe.clips,
    ...planCleanup(transcript, duration, args),
  };
}

server.registerTool("ppro_find_phrase", {
  title: "Find a spoken phrase (read-only)",
  description:
    "Locates a phrase in the transcript and returns its start/end in seconds, plus a suggested cut point that lands in the silence before it. Changes nothing.",
  inputSchema: {
    phrase: z.string().describe("Words to find, punctuation and case ignored"),
    clipId: z.string().optional(),
    preroll: z.number().optional().describe("Seconds of air to leave before the phrase (default 0.15)"),
  },
}, async ({ phrase, clipId, preroll }) => {
  try {
    const { transcript, probe } = await fetchTranscript(clipId);
    const hits = findPhrase(transcript, phrase);
    if (!hits.length) {
      return { isError: true, content: [{ type: "text", text: `phrase not found: ${JSON.stringify(phrase)}` }] };
    }
    const enriched = hits.map((h) => ({ ...h, cut: cutPointBefore(transcript, h.start, preroll ?? 0.15) }));
    return {
      content: [{ type: "text", text: JSON.stringify({
        source: probe.source,
        duration: transcriptDuration(transcript),
        matches: enriched,
      }, null, 2) }],
    };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `find failed: ${e.message}` }] };
  }
});

server.registerTool("ppro_cleanup_plan", {
  title: "Plan a cleanup (read-only)",
  description:
    "Reads the transcript and computes which spans to remove (Premiere's own disfluency tags, plus pauses) and which to keep. Changes nothing. Silences longer than maxCutSeconds are held for review rather than cut, since the transcript cannot see the picture.",
  inputSchema: {
    clipId: z.string().optional(),
    maxPauseSeconds: z.number().optional().describe("Pauses longer than this are cut (default 1.0)"),
    keepPauseSeconds: z.number().optional().describe("Air left at a trimmed pause (default 0.35)"),
    maxCutSeconds: z.number().optional().describe("Cuts longer than this are held for review (default 4)"),
    removeDisfluencies: z.boolean().optional(),
  },
}, async (args) => {
  try {
    const probe = await proxy.call("transcript.probe", { clipId: args.clipId, headBytes: 200000 });
    if (!probe.head) throw new Error(probe.note || "no transcript available");
    const transcript = JSON.parse(probe.head);
    const plan = planCleanup(transcript, transcriptDuration(transcript), args);
    return { content: [{ type: "text", text: JSON.stringify({ source: probe.source, ...plan }, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `plan failed: ${e.message}` }] };
  }
});

server.registerTool("ppro_cleanup_apply", {
  title: "Apply a cleanup to a duplicate of the sequence",
  description:
    "Duplicates the active sequence (inheriting its settings), then removes the planned spans from the copy by splitting and ripple-deleting, working end to start. Creates no subclips and no new project items. Snapshots the project first. The original sequence is untouched.",
  inputSchema: {
    clipId: z.string().optional(),
    maxPauseSeconds: z.number().optional(),
    keepPauseSeconds: z.number().optional(),
    maxCutSeconds: z.number().optional(),
    removeDisfluencies: z.boolean().optional(),
    track: z.string().optional().describe("Track carrying the dialogue (default V0)"),
    duplicate: z.boolean().optional().describe("Duplicate before editing (default true)"),
    sourceGuid: z.string().optional().describe("Sequence to duplicate; defaults to the active one"),
    dryRun: z.boolean().optional().describe("Map the cuts and report, without editing"),
  },
}, async (args) => {
  const track = args.track || "V0";
  const log = [];
  try {
    const probe = await proxy.call("transcript.probe", { clipId: args.clipId, headBytes: 200000 });
    if (!probe.head) throw new Error(probe.note || "no transcript available");
    const transcript = JSON.parse(probe.head);
    const plan = planCleanup(transcript, transcriptDuration(transcript), args);
    if (!plan.cuts.length) throw new Error("plan produced no cuts");

    if (args.duplicate !== false && !args.dryRun) {
      const dup = await proxy.call("sequence.duplicate", { guid: args.sourceGuid });
      if (!dup.ok) throw new Error(`duplicate failed: ${dup.error}`);
      if (!dup.settingsMatch) throw new Error("duplicate does not match the original's settings");
      log.push({ step: "duplicate", sequence: dup.clone.name, frameSize: dup.clone.frameSize });
    }

    const dump = await proxy.call("timeline.dump", {});
    const { mapped, skipped } = mapCuts(dump, plan.cuts, track);
    if (skipped.length) log.push({ step: "skipped", cuts: skipped });
    if (!mapped.length) throw new Error("no cuts could be mapped into sequence time");

    if (args.dryRun) {
      return { content: [{ type: "text", text: JSON.stringify({
        dryRun: true, sequence: dump.sequence.name, stats: plan.stats,
        heldForReview: plan.heldForReview, mapped, skipped, log,
      }, null, 2) }] };
    }

    const saved = await proxy.call("project.save", {});
    const snap = saved.path ? await createSnapshot(saved.path, "before-cleanup") : null;

    // End to start, so ripple never invalidates a pending coordinate.
    let applied = 0;
    for (const cut of mapped) {
      const a = await proxy.call("timeline.splitAt", { atSeconds: cut.seqEnd });
      const b = await proxy.call("timeline.splitAt", { atSeconds: cut.seqStart });
      const r = await proxy.call("timeline.removeAt", {
        atSeconds: (cut.seqStart + cut.seqEnd) / 2, ripple: true,
      });
      if (!r.ok) {
        log.push({ step: "cut", at: cut.seqStart, failed: r.error, splitEnd: a.ok, splitStart: b.ok });
        break;
      }
      applied++;
    }

    const gaps = await proxy.call("timeline.closeGaps", {});
    log.push({ step: "closeGaps", gapsClosed: gaps.gapsClosed, contiguous: gaps.contiguous });

    const after = await proxy.call("timeline.dump", {});
    const clips = (after.tracks.find((t) => t.id === track)?.items || [])
      .map((i) => ({ start: i.start.seconds, end: i.end.seconds, srcIn: i.inPoint.seconds }))
      .sort((x, y) => x.start - y.start);
    const finalEnd = clips.length ? clips[clips.length - 1].end : 0;

    return { content: [{ type: "text", text: JSON.stringify({
      snapshot: snap, sequence: after.sequence.name,
      stats: plan.stats, heldForReview: plan.heldForReview,
      cutsPlanned: mapped.length, cutsApplied: applied,
      finalDuration: Number(finalEnd.toFixed(2)), segments: clips.length,
      log,
    }, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `cleanup failed: ${e.message}\n${JSON.stringify(log, null, 2)}` }] };
  }
});

server.registerTool("ppro_reorder", {
  title: "Reorder the segments of the active sequence",
  description:
    "Rearranges the clips of the active sequence into a new order. Segments are the clips on the reference track sorted by start time, addressed 0-based. CLONES every segment into free space beyond the timeline end, already in target order, then deletes the originals and closes the leading gap — existing clips are never moved past their neighbours, which corrupts the project (api-traps §5a). Linked A/V is cloned together. Snapshots the project first. MUTATES the active sequence.",
  inputSchema: {
    order: z.array(z.number().int().nonnegative())
      .describe("Permutation of current segment indices in their new order, e.g. [0,2,1,3]"),
    track: z.string().optional().describe("Reference track for segmentation (default V0)"),
    dryRun: z.boolean().optional().describe("Report the planned moves without editing"),
  },
}, async ({ order, track = "V0", dryRun }) => {
  const log = [];
  try {
    const dump = await proxy.call("timeline.dump", {});
    const segs = (dump.tracks.find((t) => t.id === track)?.items || [])
      .map((i) => ({ start: i.start.seconds, end: i.end.seconds, srcIn: i.inPoint.seconds }))
      .sort((a, b) => a.start - b.start);
    if (!segs.length) throw new Error(`no clips on ${track}`);

    const sorted = [...order].sort((a, b) => a - b);
    if (order.length !== segs.length || sorted.some((v, i) => v !== i)) {
      throw new Error(`order must be a permutation of 0..${segs.length - 1}, got ${JSON.stringify(order)}`);
    }
    if (order.every((v, i) => v === i)) throw new Error("order is already the current order");

    const timelineEnd = Math.max(...segs.map((s) => s.end));
    const P = timelineEnd + 10;

    // Park slots laid out contiguously in TARGET order: once every segment has
    // a clone in its slot, the parked block is the final arrangement shifted
    // right by P. Deleting the originals and closing the leading gap then slides
    // the block to the origin in one proven, order-preserving motion. Existing
    // clips are never moved individually — that corrupts the project (§5a).
    let acc = 0;
    const moves = order.map((segIndex) => {
      const seg = segs[segIndex];
      const m = {
        segIndex,
        from: Number(seg.start.toFixed(3)),
        mid: (seg.start + seg.end) / 2,
        by: Number((P + acc - seg.start).toFixed(6)),
        finalStart: Number(acc.toFixed(3)),
      };
      acc += seg.end - seg.start;
      return m;
    });

    if (dryRun) {
      return { content: [{ type: "text", text: JSON.stringify({
        dryRun: true, sequence: dump.sequence.name, segments: segs.length, park: P, moves,
      }, null, 2) }] };
    }

    const saved = await proxy.call("project.save", {});
    const snap = saved.path ? await createSnapshot(saved.path, "before-reorder") : null;

    // Handles occasionally go stale mid-flight ("The script object is no longer
    // valid") even when acquired correctly — observed on both splitAt and
    // removeAt. The command re-reads state on entry, so one retry is safe.
    const withRetry = async (command, args, describe) => {
      let r = await proxy.call(command, args).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok && /no longer valid/i.test(r.error || "")) {
        log.push({ step: "retry", of: describe, firstError: r.error });
        r = await proxy.call(command, args).catch((e) => ({ ok: false, error: e.message }));
        // A failed first attempt may still have applied (the transaction is not
        // atomic around the error) — a removal retried onto nothing means done.
        if (!r.ok && command === "timeline.removeAt" && /no clip covers/i.test(r.error || "")) {
          r = { ok: true, removed: 0, note: "first attempt had already applied" };
        }
      }
      return r;
    };

    for (const m of moves) {
      const r = await withRetry("timeline.cloneAt", { atSeconds: m.mid, bySeconds: m.by }, `clone segment ${m.segIndex}`);
      if (!r.ok) throw new Error(`clone of segment ${m.segIndex} failed: ${r.error}\n${JSON.stringify(log)}`);
      log.push({ step: "clone", segment: m.segIndex, clonedPairs: r.clonedPairs, by: m.by });
    }

    // Delete the originals (no ripple — positions of the others must not shift
    // while we are still addressing them by midpoint). The parked clones start
    // at P and are untouchable by these midpoints.
    for (const seg of segs) {
      const mid = (seg.start + seg.end) / 2;
      const r = await withRetry("timeline.removeAt", { atSeconds: mid, ripple: false }, `remove original at ${mid.toFixed(2)}s`);
      if (!r.ok) throw new Error(`removal of original at ${mid.toFixed(2)}s failed: ${r.error}\n${JSON.stringify(log)}`);
      log.push({ step: "removeOriginal", at: Number(mid.toFixed(3)), removed: r.removed });
    }

    const gaps = await proxy.call("timeline.closeGaps", {});
    log.push({ step: "closeGaps", gapsClosed: gaps.gapsClosed, contiguous: gaps.contiguous });

    // Verify against the plan by re-reading: each segment's source-in must now
    // sit at its computed final start.
    const after = await proxy.call("timeline.dump", {});
    const now = (after.tracks.find((t) => t.id === track)?.items || [])
      .map((i) => ({ start: i.start.seconds, srcIn: i.inPoint.seconds }))
      .sort((a, b) => a.start - b.start);
    const verified = moves.every((m, j) =>
      now[j] && Math.abs(now[j].start - m.finalStart) < 0.05 &&
      Math.abs(now[j].srcIn - segs[m.segIndex].srcIn) < 0.05);

    return { content: [{ type: "text", text: JSON.stringify({
      ok: gaps.contiguous && verified,
      verified,
      snapshot: snap,
      sequence: after.sequence.name,
      segments: now.map((n, j) => ({
        position: j, wasSegment: moves[j].segIndex,
        start: Number(n.start.toFixed(3)), srcIn: Number(n.srcIn.toFixed(3)),
      })),
      totalDuration: gaps.totalDuration,
      log,
    }, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `reorder failed: ${e.message}` }] };
  }
});

server.registerTool("ppro_apply_cutlist", {
  title: "Assemble a cut from a keep-list, in one call",
  description:
    "Full assembly pipeline in a single call: duplicates the source sequence (optionally renaming it), cuts away everything outside the keep spans (split + ripple-remove, end to start, with retries on stale-handle flakes), sweeps orphan clones left by split false-negatives, closes gaps, then rearranges the segments into the order the keeps were listed in. Spans are in seconds of the sequence as it is at call time (for a fresh duplicate of an unedited source, sequence time == source time). Verifies the result against the plan and reports per-segment mapping. Snapshots before editing.",
  inputSchema: {
    keeps: z.array(z.object({
      start: z.number().describe("Span start, sequence seconds"),
      end: z.number().describe("Span end, sequence seconds"),
      label: z.string().optional(),
    })).min(1).describe("Spans to keep, listed in the DESIRED FINAL ORDER"),
    duplicate: z.boolean().optional().describe("Duplicate before editing (default true)"),
    sourceGuid: z.string().optional().describe("Sequence to duplicate; defaults to the active one"),
    name: z.string().optional().describe('Name for the duplicate, e.g. "draft-v1"'),
    track: z.string().optional().describe("Reference track for verification (default V0)"),
    dryRun: z.boolean().optional().describe("Report the plan without editing"),
  },
}, async ({ keeps, duplicate, sourceGuid, name, track = "V0", dryRun }) => {
  const log = [];
  const EPS = 0.15; // frame snapping tolerance observed on 26.3
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const callRetry = async (command, args, tries = 3) => {
    let r;
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(1500); // stale-handle flakes are timing-shaped; give Premiere a beat
      r = await proxy.call(command, args).catch((e) => ({ ok: false, error: e.message }));
      if (r.ok !== false) return r;
      if (!/no longer valid|produced no new item/i.test(r.error || "")) return r;
      log.push({ retry: command, error: (r.error || "").split("\n")[0] });
      // A "failed" call may have applied anyway (transactions are not atomic
      // around the error): a removal retried onto nothing, or a split retried
      // onto an already-cut boundary, means the first attempt did the work.
      if (command === "timeline.removeAt" || command === "timeline.splitAt") {
        await sleep(1000);
        const again = await proxy.call(command, args).catch((e) => ({ ok: false, error: e.message }));
        if (again.ok === false && /no clip covers|no clip spans/i.test(again.error || "")) {
          return { ok: true, note: "first attempt had already applied" };
        }
        if (again.ok !== false) return again;
        r = again;
      }
    }
    return r;
  };

  try {
    // --- plan ---------------------------------------------------------
    for (const k of keeps) {
      if (!(k.end > k.start)) throw new Error(`bad span ${JSON.stringify(k)}`);
    }
    const chrono = keeps.map((k, i) => ({ ...k, target: i }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < chrono.length; i++) {
      if (chrono[i].start < chrono[i - 1].end - 1e-6) {
        throw new Error(`keep spans overlap: ${JSON.stringify(chrono[i - 1])} and ${JSON.stringify(chrono[i])}`);
      }
    }
    // Final order: position j holds the chrono index of keeps[j].
    const order = keeps.map((k) =>
      chrono.findIndex((c) => c.target === keeps.indexOf(k)));

    // Duplicate FIRST (it activates the clone), so the dump below and every
    // cut runs against the working copy, not whatever sequence was active.
    if (!dryRun && duplicate !== false) {
      const dup = await callRetry("sequence.duplicate", { guid: sourceGuid });
      if (!dup.ok) throw new Error(`duplicate failed: ${dup.error}`);
      if (!dup.settingsMatch) throw new Error("duplicate does not match the original's settings");
      log.push({ step: "duplicate", sequence: dup.clone.name });
      if (name) {
        const rn = await callRetry("sequence.rename", { name, guid: dup.clone.guid });
        if (!rn.ok) log.push({ step: "rename", failed: rn.error });
        else log.push({ step: "rename", to: name });
      }
    }

    const dump0 = await proxy.call("timeline.dump", {});
    const rows0 = (dump0.tracks.find((t) => t.id === track)?.items || []);
    // On a dry run with an explicit sourceGuid the active sequence may be a
    // different one — skip the length check rather than validate against it.
    const checkEnd = !(dryRun && sourceGuid);
    if (checkEnd && !rows0.length) throw new Error(`no clips on ${track}`);
    const timelineEnd = rows0.length ? Math.max(...rows0.map((i) => i.end.seconds)) : Infinity;
    if (checkEnd && chrono[chrono.length - 1].end > timelineEnd + 1e-6) {
      throw new Error(`keep span ends past the timeline (${timelineEnd.toFixed(2)}s)`);
    }

    // Complement spans, end to start, so ripple never shifts a pending cut.
    const cuts = [];
    if (isFinite(timelineEnd) && timelineEnd - chrono[chrono.length - 1].end > 0.02) {
      cuts.push({ start: chrono[chrono.length - 1].end, end: timelineEnd, tail: true });
    }
    for (let i = chrono.length - 1; i > 0; i--) {
      if (chrono[i].start - chrono[i - 1].end > 0.02) {
        cuts.push({ start: chrono[i - 1].end, end: chrono[i].start });
      }
    }
    if (chrono[0].start > 0.02) cuts.push({ start: 0, end: chrono[0].start, head: true });

    // Identity of every planned segment, in SOURCE coordinates AND with the
    // project item it comes from. Source times are ripple-proof; the project
    // item id is what tells two clips apart when both start at srcIn 0 in
    // different files — which is the normal case for a stringout of takes.
    // Without the id the sweep below reads every clip as a duplicate of the
    // first and deletes the whole timeline.
    const sorted0 = [...rows0].sort((a, b) => a.start.seconds - b.start.seconds);
    // A dry run against a sequence other than the active one has no rows to
    // resolve against; the real path always does (the empty check above throws).
    const plan = !sorted0.length ? [] : chrono.map((k) => {
      // Match on the midpoint, and allow a frame of slack at the edges: callers
      // work from timings rounded to hundredths, while clip boundaries sit on
      // frames (211.8333, not 211.83). An exact containment test rejects spans
      // that are in fact inside the clip.
      const mid = (k.start + k.end) / 2;
      const host = sorted0.find((i) => i.start.seconds <= mid && i.end.seconds > mid);
      if (!host) throw new Error(`keep span [${k.start}-${k.end}] covers no clip on ${track}`);
      if (k.start < host.start.seconds - EPS || k.end > host.end.seconds + EPS) {
        throw new Error(`keep span [${k.start}-${k.end}] crosses a clip boundary` +
          ` (clip ${host.name} runs ${host.start.seconds.toFixed(2)}-${host.end.seconds.toFixed(2)})` +
          ` — spans crossing a boundary are not supported`);
      }
      const s0 = host.inPoint.seconds + Math.max(0, k.start - host.start.seconds);
      return { target: k.target, pid: host.projectItemId, s0, s1: s0 + (k.end - k.start) };
    });

    if (dryRun) {
      return { content: [{ type: "text", text: JSON.stringify({
        dryRun: true, keeps: chrono.length, cuts, order,
        expectedDuration: Number(keeps.reduce((a, k) => a + k.end - k.start, 0).toFixed(2)),
      }, null, 2) }] };
    }

    // --- snapshot --------------------------------------------------------
    // Best effort: the edit happens in a fresh duplicate, so a failed snapshot
    // (e.g. macOS denying access to the project's folder) must not abort the
    // run — it just loses the second belt.
    const saved = await proxy.call("project.save", {});
    let snap = null;
    try {
      snap = saved.path ? await createSnapshot(saved.path, "before-cutlist") : null;
    } catch (e) {
      log.push({ step: "snapshot", failed: e.message });
    }

    // Orphan sweep. Half-applied splits leave parked clones and displaced cut
    // chunks; ripple makes any TIMELINE-based test diverge from reality (an
    // arithmetic frontier reaped legitimate segments; so would a contiguity
    // chain once a half-applied split leaves a legit hole). Source coordinates
    // are ripple-proof, and the plan is defined in them, so debris is:
    //  - a clip whose source range lies inside a planned cut span (material we
    //    are removing anyway, however it got displaced), or
    //  - a clip duplicating source material already present to its left
    //    (a stacked clone from a re-split).
    // The final validation still checks exact keep spans; `mode: "keeps"`
    // additionally reaps anything not matching a keep, once cuts are done and
    // every legit segment has its final size.
    const sweep = async (mode) => {
      const d = await proxy.call("timeline.dump", {});
      const rows = (d.tracks.find((t) => t.id === track)?.items || [])
        .map((i) => ({ start: i.start.seconds, end: i.end.seconds, srcIn: i.inPoint.seconds,
                       pid: i.projectItemId }))
        .sort((a, b) => a.start - b.start);
      // Positive test: a clip survives if it IS, or still CONTAINS, a planned
      // segment of the same project item that no earlier clip has claimed.
      // Each plan entry can be claimed once, so a stacked clone of an accepted
      // segment finds nothing left and is reaped. Mid-run the test is "contains"
      // (legit material may not be trimmed to size yet); after the cuts it is
      // an exact match.
      const len = (r) => r.end - r.start;
      const isExact = (r, e) => r.pid === e.pid &&
        Math.abs(r.srcIn - e.s0) < EPS && Math.abs(len(r) - (e.s1 - e.s0)) < EPS * 2;
      const contains = (r, e) => r.pid === e.pid &&
        r.srcIn <= e.s0 + EPS && r.srcIn + len(r) >= e.s1 - EPS;
      const match = mode === "keeps" ? isExact : contains;
      const claimed = new Set();
      const orphans = [];
      for (const r of rows) {
        const j = plan.findIndex((e, i) => !claimed.has(i) && match(r, e));
        if (j === -1) orphans.push(r);
        else claimed.add(j);
      }
      // Guard. The sweep is a heuristic over undocumented behaviour; when it
      // decides that almost the whole timeline is debris, the heuristic is
      // wrong, not the timeline. Two separate identity bugs here each ended in
      // an emptied sequence before this check existed.
      if (orphans.length && rows.length - orphans.length < plan.length) {
        throw new Error(`sweep refused: it would remove ${orphans.length} of ${rows.length} clips,` +
          ` leaving fewer than the ${plan.length} planned segments — the orphan test is wrong,` +
          ` not the timeline`);
      }
      let removed = 0;
      for (const o of orphans) {
        const r = await callRetry("timeline.removeAt", { atSeconds: (o.start + o.end) / 2, ripple: false });
        log.push({ orphanRemoved: `[${o.start.toFixed(2)}-${o.end.toFixed(2)}] src:${o.srcIn.toFixed(2)}`, ok: r.ok });
        if (r.ok) removed++;
      }
      return removed;
    };

    // --- cut ------------------------------------------------------------
    const splitSturdy = async (at) => {
      await sleep(300); // bursts of commands provoke stale-handle flakes
      let r = await callRetry("timeline.splitAt", { atSeconds: at });
      if (!r.ok && /no longer valid|produced no new item/i.test(r.error || "")) {
        await sweep("mid"); // parked debris poisons further splits; reap and re-try
        await sleep(1200);
        r = await callRetry("timeline.splitAt", { atSeconds: at });
      }
      // A boundary that no clip spans is a split that already happened.
      if (!r.ok && /no clip spans/i.test(r.error || "")) {
        return { ok: true, note: "boundary already cut" };
      }
      return r;
    };
    for (const c of cuts) {
      if (!c.tail) {
        const r = await splitSturdy(c.end);
        if (!r.ok) throw new Error(`split at ${c.end} failed: ${r.error}`);
      }
      if (!c.head) {
        const r = await splitSturdy(c.start);
        if (!r.ok) throw new Error(`split at ${c.start} failed: ${r.error}`);
      }
      const mid = (c.start + c.end) / 2;
      const r = await callRetry("timeline.removeAt", { atSeconds: mid, ripple: true });
      // A span nothing covers any more was displaced by a half-applied split
      // and already reaped (or will be) by the sweep — the cut is done.
      if (!r.ok && !/no clip covers/i.test(r.error || "")) {
        throw new Error(`remove at ${mid.toFixed(2)} failed: ${r.error}`);
      }
      log.push({ cut: `[${c.start.toFixed(2)}-${c.end.toFixed(2)}]`, note: r.ok ? undefined : "span was already displaced" });
      await sleep(500); // let Premiere settle after ripple before the next split
    }

    const swept = await sweep("keeps");

    let gaps = await callRetry("timeline.closeGaps", {});
    log.push({ step: "closeGaps", ok: gaps.ok, gapsClosed: gaps.gapsClosed, segments: gaps.segments });
    if (!gaps.ok) throw new Error(`closeGaps failed: ${gaps.error}`);
    if (gaps.segments !== chrono.length) {
      throw new Error(`expected ${chrono.length} segments after cuts, found ${gaps.segments}`);
    }

    // --- reorder (park clones in target order, drop originals, close) ----
    const needsReorder = order.some((v, i) => v !== i);
    if (needsReorder) {
      const d = await proxy.call("timeline.dump", {});
      const segs = (d.tracks.find((t) => t.id === track)?.items || [])
        .map((i) => ({ start: i.start.seconds, end: i.end.seconds }))
        .sort((a, b) => a.start - b.start);
      const end2 = Math.max(...segs.map((s) => s.end));
      const P = end2 + 10;
      let acc = 0;
      for (const chronoIdx of order) {
        const seg = segs[chronoIdx];
        const parkStart = P + acc;
        let r = await callRetry("timeline.cloneAt", {
          atSeconds: (seg.start + seg.end) / 2,
          bySeconds: parkStart - seg.start,
        });
        if (!r.ok) {
          // The clone's own verification can be falsely negative (same class of
          // flake as splitAt): before failing, check whether it actually landed.
          await sleep(1500);
          const chk = await proxy.call("timeline.dump", {});
          const landed = (chk.tracks.find((t) => t.id === track)?.items || [])
            .some((i) => Math.abs(i.start.seconds - parkStart) < EPS);
          if (landed) {
            log.push({ step: "reorder", note: `clone of segment ${chronoIdx} reported failure but landed` });
            r = { ok: true };
          }
        }
        if (!r.ok) throw new Error(`reorder clone of segment ${chronoIdx} failed: ${r.error}`);
        acc += seg.end - seg.start;
      }
      for (const seg of segs) {
        const r = await callRetry("timeline.removeAt", {
          atSeconds: (seg.start + seg.end) / 2, ripple: false,
        });
        if (!r.ok) throw new Error(`reorder removal at ${seg.start.toFixed(2)} failed: ${r.error}`);
      }
      gaps = await callRetry("timeline.closeGaps", {});
      log.push({ step: "reorder", ok: gaps.ok, segments: gaps.segments });
      if (!gaps.ok) throw new Error(`closeGaps after reorder failed: ${gaps.error}`);
    }

    // --- verify against the plan -----------------------------------------
    const final = await proxy.call("timeline.dump", {});
    const now = (final.tracks.find((t) => t.id === track)?.items || [])
      .map((i) => ({ start: i.start.seconds, end: i.end.seconds, srcIn: i.inPoint.seconds,
                     pid: i.projectItemId }))
      .sort((a, b) => a.start - b.start);
    const segments = now.map((n, j) => {
      const want = keeps[j];
      // Position j must hold keeps[j]; its expected source identity is the plan
      // entry that targets j. Comparing srcIn against the keep's TIMELINE start
      // only worked while the timeline was one clip from one file.
      const e = plan.find((x) => x.target === j);
      return {
        position: j,
        label: want?.label,
        start: Number(n.start.toFixed(2)),
        srcIn: Number(n.srcIn.toFixed(2)),
        matchesPlan: !!e && n.pid === e.pid && Math.abs(n.srcIn - e.s0) < EPS &&
          Math.abs((n.end - n.start) - (e.s1 - e.s0)) < EPS * 2,
      };
    });
    const ok = now.length === keeps.length && segments.every((s) => s.matchesPlan);
    return { content: [{ type: "text", text: JSON.stringify({
      ok,
      sequence: final.sequence.name,
      duration: Number((now.length ? now[now.length - 1].end : 0).toFixed(2)),
      segments,
      orphansSwept: swept,
      snapshot: snap,
      log,
    }, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `cutlist failed: ${e.message}\n${JSON.stringify(log, null, 2)}` }] };
  }
});

await server.connect(new StdioServerTransport());
