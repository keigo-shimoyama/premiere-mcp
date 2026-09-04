/**
 * UXP panel: the only thing in this system that can touch the premierepro API.
 *
 * It dials the local proxy, registers as the "panel" peer, then serves commands
 * off a registry. Everything here is deliberately read-only for now — the probes
 * that still need a running Premiere (transcript schema, split, localhost socket)
 * are commands, not one-off scripts, so they run through the same path the real
 * agent will use.
 */
const ppro = require("premierepro");

const uxp = require("uxp");

/** ppro.Application.version reads undefined at runtime; uxp.host is the reliable source. */
function appVersion() {
  const candidates = [
    ["ppro.Application.version", () => ppro.Application?.version],
    ["uxp.host.version", () => uxp?.host?.version],
    ["uxp.host.name+version", () => (uxp?.host ? `${uxp.host.name} ${uxp.host.version}` : undefined)],
  ];
  for (const [source, get] of candidates) {
    let v;
    try { v = get(); } catch (e) { continue; }
    if (v) return { version: String(v), source };
  }
  return { version: "unknown", source: "none" };
}

const ENDPOINTS = ["ws://localhost:3001", "ws://127.0.0.1:3001"];
const RECONNECT_MS = 2000;

let ws = null;
let endpointIndex = 0;
let reconnectTimer = null;

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

function log(msg, cls = "dim") {
  const row = document.createElement("div");
  row.className = `row ${cls}`;
  row.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.childNodes.length > 300) logEl.removeChild(logEl.firstChild);
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls;
}

/* ---------------------------------------------------------------- helpers */

/**
 * Object.keys() returns nothing for the native-backed API objects, so walk the
 * prototype chain to get the real method table. This is how we check at runtime
 * whether anything split/razor-shaped exists that the .d.ts did not show.
 */
function methodsOf(obj) {
  const names = new Set();
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) {
      if (n === "constructor") continue;
      let v;
      try { v = o[n]; } catch (e) { continue; }
      if (typeof v === "function") names.add(n);
    }
  }
  return [...names].sort();
}

const tick = (t) =>
  t ? { ticks: t.ticks, ticksNumber: t.ticksNumber, seconds: t.seconds } : null;

/**
 * TrackItem has no native id (verified against the 26.3 declarations: only
 * Project, Sequence and Marker carry a guid, and UniqueSerializeable.cast does
 * not accept a TrackItem). So identity is synthesized from the tuple that is
 * actually stable across a read, and it is re-derived on every dump rather than
 * cached — see docs/probe-results.md §2.
 */
function synthesizeKey(trackType, trackIndex, projectItemId, inT, outT, startT) {
  return [
    `${trackType}${trackIndex}`,
    projectItemId || "no-source",
    `${inT?.ticks ?? "?"}-${outT?.ticks ?? "?"}`,
    `@${startT?.ticks ?? "?"}`,
  ].join("|");
}

async function describeTrackItem(item, trackType, trackIndex) {
  const [name, inT, outT, startT, endT, duration, disabled, selected, type] =
    await Promise.all([
      item.getName(),
      item.getInPoint(),
      item.getOutPoint(),
      item.getStartTime(),
      item.getEndTime(),
      item.getDuration(),
      item.isDisabled(),
      item.getIsSelected(),
      item.getType(),
    ]);

  let projectItemId = null;
  let mediaPath = null;
  try {
    const pi = await item.getProjectItem();
    if (pi) {
      projectItemId = pi.getId();
      mediaPath = pi.name;
    }
  } catch (e) {
    /* transitions and generated items have no backing project item */
  }

  return {
    key: synthesizeKey(trackType, trackIndex, projectItemId, inT, outT, startT),
    name,
    type,
    track: `${trackType}${trackIndex}`,
    projectItemId,
    source: mediaPath,
    inPoint: tick(inT),
    outPoint: tick(outT),
    start: tick(startT),
    end: tick(endT),
    duration: tick(duration),
    disabled,
    selected,
  };
}

/** Depth-limited structural sketch of an unknown JSON payload. */
function sketch(value, depth = 0, maxDepth = 4) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (depth >= maxDepth) return `[${value.length} items]`;
    return [`array(${value.length}) of`, sketch(value[0], depth + 1, maxDepth)];
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) return "{...}";
    const out = {};
    for (const k of Object.keys(value)) out[k] = sketch(value[k], depth + 1, maxDepth);
    return out;
  }
  return typeof value;
}

async function collectClipProjectItems(folderItem, acc = [], depth = 0) {
  if (depth > 8) return acc;
  const items = await folderItem.getItems();
  for (const item of items) {
    const asFolder = ppro.FolderItem.cast(item);
    if (asFolder) {
      await collectClipProjectItems(asFolder, acc, depth + 1);
      continue;
    }
    const clip = ppro.ClipProjectItem.cast(item);
    if (clip) acc.push({ clip, name: item.name, id: item.getId() });
  }
  return acc;
}

/* --------------------------------------------------------------- commands */

const commands = {
  /** Round-trip proof. Returns app identity so we know we are really inside Premiere. */
  async echo(params) {
    return {
      message: params.message ?? null,
      app: "premierepro",
      version: appVersion().version,
      receivedAt: new Date().toISOString(),
    };
  },

  /**
   * Runtime feature detection. Confirms the shipping runtime matches the
   * TypeScript declarations we designed against, and answers "is this the beta
   * channel" without guessing.
   */
  async env() {
    const project = await ppro.Project.getActiveProject();
    const present = (obj, name) => typeof obj?.[name] === "function";

    let sequenceInfo = null;
    if (project) {
      const seq = await project.getActiveSequence();
      if (seq) {
        const [v, a, c] = await Promise.all([
          seq.getVideoTrackCount(),
          seq.getAudioTrackCount(),
          seq.getCaptionTrackCount(),
        ]);
        sequenceInfo = {
          name: seq.name,
          guid: String(seq.guid),
          videoTracks: v,
          audioTracks: a,
          captionTracks: c,
        };
      }
    }

    return {
      appVersion: appVersion().version,
      appVersionSource: appVersion().source,
      project: project
        ? { name: project.name, guid: String(project.guid), path: project.path }
        : null,
      sequence: sequenceInfo,
      features: {
        // §4.4 — undo grouping
        executeTransaction: present(project, "executeTransaction"),
        lockedAccess: present(project, "lockedAccess"),
        // §4.6 — beta-only transcription trigger
        transcribeClipProjectItem: present(ppro.Transcript, "transcribeClipProjectItem"),
        isLanguagePackAvailable: present(ppro.Transcript, "isLanguagePackAvailable"),
        exportToJSON: present(ppro.Transcript, "exportToJSON"),
        exportSequenceFrame: present(ppro.Exporter, "exportSequenceFrame"),
      },
      surfaces: await (async () => {
        const seq = project ? await project.getActiveSequence() : null;
        const out = { ppro: methodsOf(ppro) };
        if (seq) {
          out.sequence = methodsOf(seq);
          try {
            const editor = ppro.SequenceEditor.getEditor(seq);
            out.sequenceEditor = editor ? methodsOf(editor) : "getEditor returned null";
          } catch (e) {
            out.sequenceEditor = `getEditor threw: ${e.message}`;
          }
          const track = await seq.getVideoTrack(0);
          out.videoTrack = track ? methodsOf(track) : null;
          const items = track ? track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) : [];
          out.trackItem = items.length ? methodsOf(items[0]) : "no clips on V0";
        }
        out.transcript = methodsOf(ppro.Transcript);
        out.exporter = methodsOf(ppro.Exporter);
        return out;
      })(),
    };
  },

  /** §9.3 — read-only timeline dump, the text representation handed to the model. */
  async "timeline.dump"() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("no active project");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("no active sequence");

    const [videoCount, audioCount] = await Promise.all([
      sequence.getVideoTrackCount(),
      sequence.getAudioTrackCount(),
    ]);

    const tracks = [];
    for (let i = 0; i < videoCount; i++) {
      const track = await sequence.getVideoTrack(i);
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      tracks.push({
        id: `V${i}`,
        name: track.name,
        muted: await track.isMuted(),
        items: await Promise.all(items.map((it) => describeTrackItem(it, "V", i))),
      });
    }
    for (let i = 0; i < audioCount; i++) {
      const track = await sequence.getAudioTrack(i);
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      tracks.push({
        id: `A${i}`,
        name: track.name,
        muted: await track.isMuted(),
        items: await Promise.all(items.map((it) => describeTrackItem(it, "A", i))),
      });
    }

    const playhead = await sequence.getPlayerPosition();
    return {
      project: { name: project.name, guid: String(project.guid) },
      sequence: { name: sequence.name, guid: String(sequence.guid) },
      playhead: tick(playhead),
      tracks,
    };
  },

  /** §4.3 — selection + playhead: "what is the human looking at". */
  async "selection.get"() {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("no active sequence");

    const selection = await sequence.getSelection();
    const items = selection ? await selection.getTrackItems() : [];
    const described = [];
    for (const item of items) {
      const trackIndex = await item.getTrackIndex();
      described.push(await describeTrackItem(item, "?", trackIndex));
    }
    return {
      playhead: tick(await sequence.getPlayerPosition()),
      count: described.length,
      items: described,
    };
  },

  /**
   * createAddItemAction / createAddItemsAction exist in the 26.3.2 runtime but
   * appear in no .d.ts, stable or beta. Report their arity as a first clue to
   * the signature, since they are the likeliest route to a synthetic split.
   */
  async "debug.arity"() {
    const project = await ppro.Project.getActiveProject();
    const seq = await project.getActiveSequence();
    const editor = ppro.SequenceEditor.getEditor(seq);
    const report = {};
    for (const name of methodsOf(editor)) {
      const fn = editor[name];
      report[name] = { arity: typeof fn === "function" ? fn.length : null };
    }
    return { sequenceEditor: report, toStringSample: String(editor.createAddItemsAction).slice(0, 400) };
  },

  /**
   * Saves the project so a file-level snapshot captures on-screen state rather
   * than the last save point. Mutates nothing in the timeline.
   */
  async "project.save"() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("no active project");
    const saved = await project.save();
    return { saved, path: project.path, name: project.name };
  },

  /**
   * Reflective invoker for exploring undocumented bindings without a reload per
   * guess. Deliberately cannot commit: it only ever calls the method and reports
   * what came back, so create*Action builds an Action and nothing mutates.
   *
   * Args may embed directives that construct native objects:
   *   {"$seconds": 1.5}            -> TickTime.createWithSeconds
   *   {"$ticks": "254016000000"}   -> TickTime.createWithTicks
   *   {"$projectItemId": "<guid>"} -> ProjectItem looked up by id
   *   {"$trackItem": {"track":"V0","index":0}}
   *   {"$selection": [{"track":"V0","index":0}]}
   *   {"$const": "MediaType.VIDEO"}
   */
  async "debug.invoke"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();

    async function trackItemAt(spec) {
      const kind = String(spec.track).slice(0, 1).toUpperCase();
      const idx = Number(String(spec.track).slice(1));
      const track = kind === "A" ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      return items[spec.index ?? 0];
    }

    async function resolveArg(a) {
      if (Array.isArray(a)) {
        const out = [];
        for (const el of a) out.push(await resolveArg(el));
        return out;
      }
      if (a === null || typeof a !== "object") return a;
      if ("$seconds" in a) return ppro.TickTime.createWithSeconds(a.$seconds);
      if ("$ticks" in a) return ppro.TickTime.createWithTicks(String(a.$ticks));
      if ("$trackItem" in a) return await trackItemAt(a.$trackItem);
      if ("$projectItemId" in a) {
        const root = await project.getRootItem();
        const found = await collectClipProjectItems(root);
        const hit = found.find((c) => c.id === a.$projectItemId);
        if (!hit) throw new Error(`no project item with id ${a.$projectItemId}`);
        return ppro.ProjectItem.cast(hit.clip);
      }
      if ("$selection" in a) {
        // createEmptySelection hands the selection to a callback rather than
        // returning it, so grab it synchronously from there.
        let fresh = null;
        ppro.TrackItemSelection.createEmptySelection((sel) => { fresh = sel; });
        if (!fresh) throw new Error("createEmptySelection did not yield a selection");
        for (const spec of a.$selection) fresh.addItem(await trackItemAt(spec), true);
        return fresh;
      }
      if ("$liveSelection" in a) return await sequence.getSelection();
      if ("$const" in a) {
        const [group, key] = String(a.$const).split(".");
        return ppro.Constants[group][key];
      }
      return a;
    }

    const targets = {
      trackItem: async () => await trackItemAt(params.on || { track: "V0", index: 0 }),
      sequenceEditor: () => ppro.SequenceEditor.getEditor(sequence),
      sequence: () => sequence,
      project: () => project,
      transcript: () => ppro.Transcript,
      exporter: () => ppro.Exporter,
    };
    const resolveTarget = targets[params.target];
    if (!resolveTarget) throw new Error(`unknown target: ${params.target}`);
    const obj = await resolveTarget();
    const fn = obj[params.method];
    if (typeof fn !== "function") throw new Error(`${params.target}.${params.method} is not a function`);

    const args = [];
    for (const a of params.args || []) args.push(await resolveArg(a));

    try {
      let out;
      if (params.lockedAccess) {
        // lockedAccess takes a synchronous callback and freezes project state
        // for its duration; still no transaction, so nothing is committed.
        let inner, threw;
        project.lockedAccess(() => {
          try { inner = fn.apply(obj, args); } catch (e) { threw = e; }
        });
        if (threw) throw threw;
        out = inner;
      } else {
        out = fn.apply(obj, args);
      }
      if (out && typeof out.then === "function") out = await out;
      return {
        called: `${params.target}.${params.method}(${args.length} args)${params.lockedAccess ? " [lockedAccess]" : ""}`,
        ok: true,
        resultType: out === null ? "null" : typeof out,
        resultMethods: out && typeof out === "object" ? methodsOf(out) : undefined,
        resultValue: ["string", "number", "boolean"].includes(typeof out) ? out : undefined,
      };
    } catch (e) {
      return {
        called: `${params.target}.${params.method}(${args.length} args)`,
        ok: false,
        error: e?.message || String(e),
      };
    }
  },

  /** Lists sequences with their frame size, so settings mismatches are visible. */
  async "sequence.list"() {
    const project = await ppro.Project.getActiveProject();
    const seqs = await project.getSequences();
    const active = await project.getActiveSequence();
    const out = [];
    for (const s of seqs) {
      let frame = null;
      try {
        const r = await s.getFrameSize();
        frame = { width: r.width, height: r.height };
      } catch (e) { /* older runtimes */ }
      out.push({
        name: s.name,
        guid: String(s.guid),
        frameSize: frame,
        active: active ? String(s.guid) === String(active.guid) : false,
      });
    }
    return { sequences: out };
  },

  /**
   * Duplicates a sequence and works in the copy.
   *
   * createSequence() builds from the DEFAULT preset, which silently gives a
   * 16:9 timeline for 9:16 footage. Cloning inherits frame size, frame rate and
   * every other setting from the editor's own sequence, so the agent's version
   * can never disagree with the original about its format.
   */
  async "sequence.duplicate"(params) {
    const project = await ppro.Project.getActiveProject();
    const before = await project.getSequences();
    const beforeGuids = new Set(before.map((s) => String(s.guid)));

    const source = params.guid
      ? before.find((s) => String(s.guid) === params.guid)
      : await project.getActiveSequence();
    if (!source) throw new Error("source sequence not found");

    const srcFrame = await source.getFrameSize();

    let err = null;
    try {
      project.lockedAccess(() => {
        project.executeTransaction((tx) => {
          tx.addAction(source.createCloneAction());
        }, `agent: duplicate ${source.name}`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }
    if (err) return { ok: false, stage: "clone", error: err };

    const after = await project.getSequences();
    const fresh = after.filter((s) => !beforeGuids.has(String(s.guid)));
    if (fresh.length !== 1) {
      return { ok: false, stage: "clone", error: `expected 1 new sequence, found ${fresh.length}` };
    }
    const clone = fresh[0];

    let activated = false;
    try {
      activated = await project.setActiveSequence(clone);
      await project.openSequence(clone);
    } catch (e) { /* activation is convenience, not correctness */ }

    const cloneFrame = await clone.getFrameSize();
    return {
      ok: true,
      source: { name: source.name, guid: String(source.guid), frameSize: { width: srcFrame.width, height: srcFrame.height } },
      clone: { name: clone.name, guid: String(clone.guid), frameSize: { width: cloneFrame.width, height: cloneFrame.height } },
      settingsMatch: srcFrame.width === cloneFrame.width && srcFrame.height === cloneFrame.height,
      activated,
    };
  },

  /**
   * Removes everything before `atSeconds` and closes the gap, in place.
   *
   * Two phases, each its own transaction:
   *   1. setStart on every clip spanning the cut — trims the head, leaves a gap
   *   2. ripple-delete the empty gap — shifts everything back to the origin
   *
   * createMoveAction cannot be used for step 2: it shifts by an offset and
   * rejects a negative TickTime ("Invalid parameter"), so there is no way to
   * move a clip earlier with it.
   *
   * Every Action is constructed BEFORE its transaction opens. A throw inside
   * the executeTransaction callback does NOT roll back actions already added —
   * verified the hard way — so building first is what keeps this atomic.
   */
  async "timeline.trimHead"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const at = ppro.TickTime.createWithSeconds(params.atSeconds);

    const allTracks = async () => {
      const [vCount, aCount] = await Promise.all([
        sequence.getVideoTrackCount(),
        sequence.getAudioTrackCount(),
      ]);
      const out = [];
      for (let i = 0; i < vCount; i++) out.push({ track: await sequence.getVideoTrack(i), id: `V${i}` });
      for (let i = 0; i < aCount; i++) out.push({ track: await sequence.getAudioTrack(i), id: `A${i}` });
      return out;
    };

    // Phase 1 — trim heads. Skip clips already sitting at the cut point so the
    // command can be re-run safely after a partial failure.
    const tracks = await allTracks();
    const toTrim = [];
    for (const { track, id } of tracks) {
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
      for (let i = 0; i < items.length; i++) {
        if (!items[i]) continue;
        const [st, en] = await Promise.all([items[i].getStartTime(), items[i].getEndTime()]);
        if (en.seconds > params.atSeconds && st.seconds < params.atSeconds - 1e-6) {
          toTrim.push({ track, id, index: i, before: { start: st.seconds, end: en.seconds } });
        }
      }
    }

    let trimError = null;
    if (toTrim.length) {
      try {
        /**
         * Same rule as phase 2 below: re-acquire the items and BUILD the actions
         * INSIDE lockedAccess. Building createSetStartAction outside the lock
         * used to work and now throws "Requires locked access" — and handles
         * taken during the async scan above are stale-prone regardless (§1).
         */
        project.lockedAccess(() => {
          const actions = [];
          for (const { track, index } of toTrim) {
            const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
            if (items[index]) actions.push(items[index].createSetStartAction(at));
          }
          project.executeTransaction((tx) => {
            for (const a of actions) tx.addAction(a);
          }, `agent: trim head to ${params.atSeconds}s`);
        });
      } catch (e) {
        trimError = e?.message || String(e);
      }
    }

    /**
     * Phase 2 — shift the trimmed clips back to the origin.
     *
     * This MUST be a separate transaction built from a fresh read. Building the
     * move alongside the trim fails with "Invalid parameter", because at build
     * time the clip is still at 0 and the negative shift would place it before
     * the start of the timeline. Once the trim has committed, the same negative
     * shift is valid.
     */
    let rippleError = null;
    let rippled = false;
    const gaps = [];
    const toShift = [];
    const trackObjs = await allTracks();
    for (const { track, id } of trackObjs) {
      for (const it of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []) {
        if (!it) continue;
        const st = await it.getStartTime();
        if (st.seconds > 1e-6) toShift.push({ it, id, by: -st.seconds });
      }
    }
    if (toShift.length) {
      // Every clip shifts by the same amount, so relative timing is preserved.
      const by = Math.max(...toShift.map((t) => t.by));
      gaps.push({ track: "all", span: [0, -by] });
      const shiftTick = ppro.TickTime.createWithSeconds(by);
      try {
        /**
         * Track item handles taken outside this scope go stale — the API throws
         * "The script object is no longer valid" when they are used to build an
         * action later. So re-acquire the items INSIDE lockedAccess and build
         * there. getTrackItems is synchronous, which is what makes this possible
         * inside a callback that cannot await.
         */
        project.lockedAccess(() => {
          const actions = [];
          for (const { track } of trackObjs) {
            for (const it of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []) {
              if (it) actions.push(it.createMoveAction(shiftTick));
            }
          }
          project.executeTransaction((tx) => {
            for (const a of actions) tx.addAction(a);
          }, `agent: close ${(-by).toFixed(2)}s gap`);
        });
        rippled = true;
      } catch (e) {
        rippleError = e?.message || String(e);
      }
    }

    // Verify by re-reading, never from the calls above.
    const after = [];
    for (const { track, id } of await allTracks()) {
      for (const it of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []) {
        if (!it) continue;
        const [st, en, ip] = await Promise.all([it.getStartTime(), it.getEndTime(), it.getInPoint()]);
        after.push({ track: id, start: st.seconds, end: en.seconds, sourceIn: ip.seconds });
      }
    }

    return {
      ok: !trimError && !rippleError && after.length > 0 && after.every((a) => Math.abs(a.start) < 0.05),
      trimError,
      rippleError,
      trimmed: toTrim.length,
      gapsFound: gaps.map((g) => ({ track: g.id, span: g.span })),
      rippled,
      clips: after,
    };
  },

  /**
   * Removes project items by name prefix — for clearing agent scratch items.
   *
   * Subclips and duplicated source items bloat the project and complicate
   * collect-and-share, so anything the agent creates in the project panel has
   * to be cleanable. The preferred answer is not to create them at all: edit a
   * duplicated sequence in place instead.
   */
  async "project.removeItems"(params) {
    const project = await ppro.Project.getActiveProject();
    const root = await project.getRootItem();
    const prefix = params.prefix;
    if (!prefix) throw new Error("a name prefix is required");

    const all = await collectClipProjectItems(root);
    const names = all.filter((c) => c.name.startsWith(prefix)).map((c) => c.name);
    if (!names.length) return { removed: 0, matched: [] };

    let err = null;
    try {
      /**
       * Handles go stale across awaits, so re-acquire everything immediately
       * before building the actions and do not await in between. getItems is
       * async, so this cannot happen inside lockedAccess — the next best thing
       * is one fresh shallow read with no awaits after it.
       */
      const freshRoot = await project.getRootItem();
      const items = await freshRoot.getItems();
      const targets = items.filter((i) => names.includes(i.name));
      // An item must be removed from its actual parent bin, not from root.
      // getParentBin is synchronous, so this adds no await to go stale across.
      const actions = targets.map((i) => {
        const parent = i.getParentBin() || freshRoot;
        return parent.createRemoveItemAction(i);
      });
      const doomed = targets.map((i) => ({ name: i.name }));
      project.lockedAccess(() => {
        project.executeTransaction((tx) => {
          for (const a of actions) tx.addAction(a);
        }, `agent: remove ${actions.length} scratch item(s)`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }

    const left = (await collectClipProjectItems(await project.getRootItem()))
      .filter((c) => c.name.startsWith(prefix));
    return {
      removed: names.length - left.length,
      error: err,
      matched: names,
      remaining: left.map((d) => d.name),
    };
  },

  /**
   * Renames a sequence. Sequence itself has no rename action — its ProjectItem
   * does (createSetNameAction), and getProjectItem() hands it to us.
   */
  async "sequence.rename"(params) {
    const project = await ppro.Project.getActiveProject();
    const seqs = await project.getSequences();
    const target = params.guid
      ? seqs.find((s) => String(s.guid) === params.guid)
      : await project.getActiveSequence();
    if (!target) throw new Error("sequence not found");
    if (!params.name) throw new Error("a new name is required");
    const oldName = target.name;

    let err = null;
    try {
      // getProjectItem is async, so take it right before the lock with no
      // awaits in between; the action itself must be BUILT inside lockedAccess
      // ("Requires locked access" otherwise).
      const pi = await target.getProjectItem();
      project.lockedAccess(() => {
        const action = pi.createSetNameAction(params.name);
        project.executeTransaction((tx) => tx.addAction(action),
          `agent: rename sequence to ${params.name}`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }

    const fresh = (await project.getSequences())
      .find((s) => String(s.guid) === String(target.guid));
    return {
      ok: !err && fresh?.name === params.name,
      error: err,
      before: oldName,
      after: fresh?.name ?? null,
      guid: String(target.guid),
    };
  },

  /** Removes a sequence, for cleaning up agent scratch work. */
  async "sequence.delete"(params) {
    const project = await ppro.Project.getActiveProject();
    const seqs = await project.getSequences();
    const target = seqs.find((s) => String(s.guid) === params.guid || s.name === params.name);
    if (!target) throw new Error("sequence not found");
    const name = target.name;
    const deleted = await project.deleteSequence(target);
    return { deleted, name };
  },

  /**
   * §6 — the verification loop: grab a frame of the composite from the Program
   * Monitor. This is the one thing ffmpeg cannot give us, because it knows
   * nothing about effects, MOGRTs, colour or transitions.
   *
   * exportSequenceFrame takes the time as an argument, so the editor's playhead
   * is never moved to take a picture.
   */
  async "monitor.grabFrame"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("no active sequence");

    const at = ppro.TickTime.createWithSeconds(params.atSeconds);
    const dir = params.dir;
    const file = params.filename || `frame_${String(params.atSeconds).replace(".", "_")}.png`;

    const ok = await ppro.Exporter.exportSequenceFrame(
      sequence,
      at,
      file,
      dir,
      params.width || 640,
      params.height || 360
    );
    return {
      ok,
      sequence: sequence.name,
      atSeconds: params.atSeconds,
      path: `${dir}/${file}`,
    };
  },

  /**
   * Smallest possible mutation: move a clip's end so it finishes at `atSeconds`.
   * One clip, one action, one named transaction — the simplest thing that
   * proves the write path works end to end.
   */
  async "timeline.trim"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const kind = String(params.track || "V0").slice(0, 1).toUpperCase();
    const idx = Number(String(params.track || "V0").slice(1));
    const track = kind === "A" ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    const item = items[params.index ?? 0];
    if (!item) throw new Error(`no clip at ${params.track || "V0"}[${params.index ?? 0}]`);

    const [start, end] = await Promise.all([item.getStartTime(), item.getEndTime()]);
    const at = ppro.TickTime.createWithSeconds(params.atSeconds);
    if (at.seconds <= start.seconds) {
      throw new Error(`${params.atSeconds}s is at or before the clip start (${start.seconds}s)`);
    }

    /**
     * A linked A/V pair is two independent track items here — trimming the video
     * leaves the audio at full length and the timeline silently wrong. So gather
     * the counterparts on the other media type that share this clip's source and
     * span, and trim them in the same transaction.
     */
    const partners = [];
    if (params.includeLinked !== false) {
      const srcId = await (async () => {
        try { return (await item.getProjectItem())?.getId(); } catch (e) { return null; }
      })();
      const otherCount = kind === "V"
        ? await sequence.getAudioTrackCount()
        : await sequence.getVideoTrackCount();
      for (let i = 0; i < otherCount; i++) {
        const t = kind === "V" ? await sequence.getAudioTrack(i) : await sequence.getVideoTrack(i);
        for (const cand of t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
          let candId = null;
          try { candId = (await cand.getProjectItem())?.getId(); } catch (e) { /* no source */ }
          if (!srcId || candId !== srcId) continue;
          const [cs, ce] = await Promise.all([cand.getStartTime(), cand.getEndTime()]);
          if (Math.abs(cs.seconds - start.seconds) < 1e-6 && Math.abs(ce.seconds - end.seconds) < 1e-6) {
            partners.push({ item: cand, track: `${kind === "V" ? "A" : "V"}${i}` });
          }
        }
      }
    }

    const before = { start: start.seconds, end: end.seconds };
    let err = null;
    try {
      project.lockedAccess(() => {
        project.executeTransaction((tx) => {
          tx.addAction(item.createSetEndAction(at));
          for (const p of partners) tx.addAction(p.item.createSetEndAction(at));
        }, `agent: trim to ${params.atSeconds}s`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }

    // Re-read rather than trusting the call: the ok flag above was true for a
    // trim that left the linked audio untouched, so verification re-reads every
    // item that should have moved.
    const fresh = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)[params.index ?? 0];
    const after = fresh
      ? { start: (await fresh.getStartTime()).seconds, end: (await fresh.getEndTime()).seconds }
      : null;
    const partnerAfter = [];
    for (const p of partners) {
      partnerAfter.push({ track: p.track, end: (await p.item.getEndTime()).seconds });
    }

    const near = (v) => Math.abs(v - params.atSeconds) < 0.05;
    return {
      ok: !err && !!after && near(after.end) && partnerAfter.every((p) => near(p.end)),
      error: err,
      before,
      after,
      linkedTrimmed: partnerAfter,
      requested: params.atSeconds,
    };
  },

  /**
   * Splits every clip crossing a sequence time — the razor the API lacks.
   *
   * A same-track clone at offset 0 is rejected (two clips cannot share a range),
   * but a clone parked in EMPTY space further along the track is legal. So:
   * copy out to open ground, trim original to head and copy to tail, then slide
   * the copy back.
   *
   *   [====== C ======]                        original, spans the cut
   *   [====== C ======]      [===== C' =====]  1. clone to free space at +F
   *   [== C ==]              [====== C' ====]  2. original: setEnd(at)
   *   [== C ==]                     [== C' =]  3. copy: setStart(at+F)
   *   [== C ==][== C' =]                       4. copy: move by -F
   *
   * Separate transactions throughout: each step is built from a fresh read of
   * the previous result, because handles go stale across awaits and
   * createMoveAction validates its resulting position when the action is built.
   *
   * Items are addressed by INDEX within a track. Start times are async so they
   * cannot be read inside lockedAccess, but getTrackItems is synchronous — so
   * indices are computed outside and the items re-acquired by index inside.
   */
  async "timeline.splitAt"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const at = params.atSeconds;

    const trackRefs = async () => {
      const [v, a] = await Promise.all([
        sequence.getVideoTrackCount(),
        sequence.getAudioTrackCount(),
      ]);
      const out = [];
      for (let i = 0; i < v; i++) out.push({ track: await sequence.getVideoTrack(i), id: `V${i}` });
      for (let i = 0; i < a; i++) out.push({ track: await sequence.getAudioTrack(i), id: `A${i}` });
      return out;
    };

    /** Per-track item list with times and indices, read fresh. */
    const readTracks = async (tracks) => {
      const out = [];
      for (const { track, id } of tracks) {
        const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
        const rows = [];
        for (let i = 0; i < items.length; i++) {
          if (!items[i]) continue;
          const [st, en] = await Promise.all([items[i].getStartTime(), items[i].getEndTime()]);
          rows.push({ index: i, start: st.seconds, end: en.seconds });
        }
        out.push({ track, id, rows });
      }
      return out;
    };

    /** Runs one transaction, re-acquiring items by index inside the lock. */
    const commit = (tracks, pick, label) => {
      project.lockedAccess(() => {
        // getEditor is synchronous, so take it inside the lock — an editor
        // captured outside goes stale the same way track items do.
        const editor = ppro.SequenceEditor.getEditor(sequence);
        const actions = [];
        for (const { track, id } of tracks) {
          const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
          for (const { index, make } of pick(id)) {
            const it = items[index];
            if (it) actions.push(make(it, editor));
          }
        }
        project.executeTransaction((tx) => {
          for (const a of actions) tx.addAction(a);
        }, label);
      });
    };

    const tracks = await trackRefs();
    let state = await readTracks(tracks);

    const spans = (r) => r.start < at - 1e-6 && r.end > at + 1e-6;
    if (!state.some((t) => t.rows.some(spans))) throw new Error(`no clip spans ${at}s`);

    const timelineEnd = Math.max(...state.flatMap((t) => t.rows.map((r) => r.end)));
    const F = timelineEnd + 10;

    // 1 — clone the spanning clips out to free space.
    const offset = ppro.TickTime.createWithSeconds(F);
    const cloneTargets = Object.fromEntries(
      state.map((t) => [t.id, t.rows.filter(spans).map((r) => ({
        index: r.index,
        make: (it, editor) => editor.createCloneTrackItemAction(it, offset, 0, 0, true, false),
      }))])
    );
    try {
      commit(tracks, (id) => cloneTargets[id] || [], `agent: clone for split at ${at}s`);
    } catch (e) {
      return { ok: false, stage: "clone", error: e?.message || String(e) };
    }

    state = await readTracks(tracks);
    let parkedCount = state.reduce((n, t) => n + t.rows.filter((r) => r.start >= F - 1e-6).length, 0);
    if (!parkedCount) {
      // Right after a ripple removal the first read is often stale: the clone
      // exists but is not visible yet. Failing here made the caller re-split
      // and stack orphan clones. Wait and re-read before giving up.
      await new Promise((res) => setTimeout(res, 1200));
      state = await readTracks(tracks);
      parkedCount = state.reduce((n, t) => n + t.rows.filter((r) => r.start >= F - 1e-6).length, 0);
    }
    if (!parkedCount) {
      return { ok: false, stage: "clone", error: "clone into free space produced no new item" };
    }

    // 2 — trim originals to the head, copies to the tail, in one transaction.
    const atTick = ppro.TickTime.createWithSeconds(at);
    const atShifted = ppro.TickTime.createWithSeconds(at + F);
    const trims = Object.fromEntries(state.map((t) => [t.id, [
      ...t.rows.filter(spans).map((r) => ({ index: r.index, make: (it) => it.createSetEndAction(atTick) })),
      ...t.rows.filter((r) => r.start >= F - 1e-6)
        .map((r) => ({ index: r.index, make: (it) => it.createSetStartAction(atShifted) })),
    ]]));
    try {
      commit(tracks, (id) => trims[id] || [], `agent: split at ${at}s`);
    } catch (e) {
      return { ok: false, stage: "trim", error: e?.message || String(e), state: await readTracks(tracks) };
    }

    // 3 — slide the copies back into place.
    state = await readTracks(tracks);
    const backShift = ppro.TickTime.createWithSeconds(-F);
    const moves = Object.fromEntries(state.map((t) => [t.id,
      t.rows.filter((r) => r.start >= F - 1e-6)
        .map((r) => ({ index: r.index, make: (it) => it.createMoveAction(backShift) })),
    ]));
    try {
      commit(tracks, (id) => moves[id] || [], `agent: place split tail at ${at}s`);
    } catch (e) {
      return { ok: false, stage: "move", error: e?.message || String(e), state: await readTracks(tracks) };
    }

    const final = await readTracks(tracks);
    // Only tracks that actually hold clips can evidence the cut; empty tracks
    // must not drag the verdict down.
    const populated = final.filter((t) => t.rows.length);
    const contiguous = populated.length > 0 && populated.every((t) => {
      const rows = [...t.rows].sort((a, b) => a.start - b.start);
      return rows.some((r) => Math.abs(r.end - at) < 0.05) && rows.some((r) => Math.abs(r.start - at) < 0.05);
    });
    return {
      ok: contiguous,
      at,
      tracks: final.map((t) => ({
        id: t.id,
        clips: [...t.rows].sort((a, b) => a.start - b.start)
          .map((r) => ({ start: Number(r.start.toFixed(3)), end: Number(r.end.toFixed(3)) })),
      })),
    };
  },

  /**
   * Removes the clips covering a sequence time, optionally rippling the rest
   * left to close the hole. With splitAt above, this completes the set needed
   * to cut a span out of the middle of a clip.
   */
  async "timeline.removeAt"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const at = params.atSeconds;
    const ripple = params.ripple !== false;
    const onlyTrack = params.onlyTrack || null; // e.g. "V1": remove just that track's clip
    const shiftOverlapping = params.shiftOverlapping === true; // undocumented 4th arg, semantics under probe

    const [vCount, aCount] = await Promise.all([
      sequence.getVideoTrackCount(),
      sequence.getAudioTrackCount(),
    ]);
    const tracks = [];
    for (let i = 0; i < vCount; i++) tracks.push({ track: await sequence.getVideoTrack(i), id: `V${i}` });
    for (let i = 0; i < aCount; i++) tracks.push({ track: await sequence.getAudioTrack(i), id: `A${i}` });

    // Work out which indices to remove outside the lock (times are async),
    // then re-acquire those items by index inside it.
    const doomed = {};
    let found = 0;
    for (const { track, id } of tracks) {
      doomed[id] = [];
      if (onlyTrack && id !== onlyTrack) continue;
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
      for (let i = 0; i < items.length; i++) {
        if (!items[i]) continue;
        const [st, en] = await Promise.all([items[i].getStartTime(), items[i].getEndTime()]);
        if (st.seconds <= at + 1e-6 && en.seconds > at + 1e-6) { doomed[id].push(i); found++; }
      }
    }
    if (!found) throw new Error(`no clip covers ${at}s${onlyTrack ? ` on ${onlyTrack}` : ""}`);

    let err = null;
    try {
      project.lockedAccess(() => {
        const editor = ppro.SequenceEditor.getEditor(sequence);
        let selection = null;
        ppro.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
        if (!selection) throw new Error("could not create a selection");
        for (const { track, id } of tracks) {
          const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
          for (const i of doomed[id]) if (items[i]) selection.addItem(items[i], true);
        }
        const action = editor.createRemoveItemsAction(
          selection, ripple, ppro.Constants.MediaType.ANY, shiftOverlapping
        );
        project.executeTransaction((tx) => tx.addAction(action),
          `agent: remove clip at ${at}s${ripple ? " (ripple)" : ""}`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }

    const after = [];
    for (const { track, id } of tracks) {
      for (const it of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []) {
        if (!it) continue;
        const [st, en] = await Promise.all([it.getStartTime(), it.getEndTime()]);
        after.push({ track: id, start: Number(st.seconds.toFixed(3)), end: Number(en.seconds.toFixed(3)) });
      }
    }
    return { ok: !err, error: err, removed: found, ripple, clips: after.sort((a, b) => a.start - b.start) };
  },

  /**
   * Moves the clips covering a sequence time by an offset, across all tracks
   * in one transaction — so a linked A/V pair travels together.
   *
   * createMoveAction takes an OFFSET and validates the resulting position when
   * the action is BUILT: a negative shift that would land before 0, or a move
   * into occupied space, throws at build time. Callers who need to move a clip
   * left into free space should instead park it right and let closeGaps pull
   * everything back — that path is already proven.
   */
  async "timeline.moveAt"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const at = params.atSeconds;
    const by = params.bySeconds;
    if (typeof by !== "number" || !isFinite(by)) throw new Error("bySeconds must be a number");

    const [vCount, aCount] = await Promise.all([
      sequence.getVideoTrackCount(),
      sequence.getAudioTrackCount(),
    ]);
    const tracks = [];
    for (let i = 0; i < vCount; i++) tracks.push({ track: await sequence.getVideoTrack(i), id: `V${i}` });
    for (let i = 0; i < aCount; i++) tracks.push({ track: await sequence.getAudioTrack(i), id: `A${i}` });

    // Indices are computed outside the lock (times are async), items re-acquired
    // by index inside it — same addressing pattern as removeAt.
    const targets = {};
    let found = 0;
    const before = [];
    for (const { track, id } of tracks) {
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
      targets[id] = [];
      for (let i = 0; i < items.length; i++) {
        if (!items[i]) continue;
        const [st, en] = await Promise.all([items[i].getStartTime(), items[i].getEndTime()]);
        if (st.seconds <= at + 1e-6 && en.seconds > at + 1e-6) {
          targets[id].push(i);
          before.push({ track: id, start: st.seconds, end: en.seconds });
          found++;
        }
      }
    }
    if (!found) throw new Error(`no clip covers ${at}s`);

    const shift = ppro.TickTime.createWithSeconds(by);
    let err = null;
    try {
      project.lockedAccess(() => {
        const actions = [];
        for (const { track, id } of tracks) {
          const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
          for (const i of targets[id]) if (items[i]) actions.push(items[i].createMoveAction(shift));
        }
        project.executeTransaction((tx) => {
          for (const a of actions) tx.addAction(a);
        }, `agent: move ${found} clip(s) at ${at}s by ${by.toFixed(3)}s`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }

    // Verify by re-reading, never from the calls above.
    const after = [];
    for (const { track, id } of tracks) {
      for (const it of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []) {
        if (!it) continue;
        const [st, en] = await Promise.all([it.getStartTime(), it.getEndTime()]);
        after.push({ track: id, start: Number(st.seconds.toFixed(3)), end: Number(en.seconds.toFixed(3)) });
      }
    }
    const expected = before.map((b) => ({ track: b.track, start: b.start + by }));
    const landed = expected.every((e) =>
      after.some((a) => a.track === e.track && Math.abs(a.start - e.start) < 0.05));
    return {
      ok: !err && landed,
      error: err,
      moved: found,
      by,
      before: before.map((b) => ({ track: b.track, start: Number(b.start.toFixed(3)), end: Number(b.end.toFixed(3)) })),
      clips: after.sort((a, b) => a.start - b.start),
    };
  },

  /**
   * Clones the clips covering a sequence time to an offset, across all tracks
   * in one transaction — the linked A/V pair is cloned together.
   *
   * This is the safe way to relocate a segment: a clone is a NEW track item, so
   * the track's chronological order invariant is never violated, unlike moving
   * an existing clip past its neighbours (api-traps §5a — corrupts the project).
   * The clone must land in FREE space; a clone into an occupied range is
   * rejected by the API.
   */
  async "timeline.cloneAt"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const at = params.atSeconds;
    const by = params.bySeconds;
    if (typeof by !== "number" || !isFinite(by)) throw new Error("bySeconds must be a number");
    const onlyTrack = params.onlyTrack || null;             // e.g. "V0": clone just that track's item
    const vOffset = params.videoTrackOffset ?? 0;           // vertical: V0 + 1 lands on V1
    const aOffset = params.audioTrackOffset ?? 0;

    const [vCount, aCount] = await Promise.all([
      sequence.getVideoTrackCount(),
      sequence.getAudioTrackCount(),
    ]);
    const tracks = [];
    for (let i = 0; i < vCount; i++) tracks.push({ track: await sequence.getVideoTrack(i), id: `V${i}`, kind: "V" });
    for (let i = 0; i < aCount; i++) tracks.push({ track: await sequence.getAudioTrack(i), id: `A${i}`, kind: "A" });

    const targets = {};
    let found = 0;
    const before = [];
    for (const { track, id } of tracks) {
      targets[id] = [];
      if (onlyTrack && id !== onlyTrack) continue;
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
      for (let i = 0; i < items.length; i++) {
        if (!items[i]) continue;
        const [st, en] = await Promise.all([items[i].getStartTime(), items[i].getEndTime()]);
        if (st.seconds <= at + 1e-6 && en.seconds > at + 1e-6) {
          targets[id].push(i);
          before.push({ track: id, kind: id[0], start: st.seconds, end: en.seconds });
          found++;
        }
      }
    }
    if (!found) throw new Error(`no clip covers ${at}s${onlyTrack ? ` on ${onlyTrack}` : ""}`);

    const offset = ppro.TickTime.createWithSeconds(by);
    let err = null;
    try {
      project.lockedAccess(() => {
        const editor = ppro.SequenceEditor.getEditor(sequence);
        const actions = [];
        for (const { track, id, kind } of tracks) {
          const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
          for (const i of targets[id]) {
            if (!items[i]) continue;
            // Vertical offsets land the clone on another track of the same kind.
            const vo = kind === "V" ? vOffset : 0;
            const ao = kind === "A" ? aOffset : 0;
            actions.push(editor.createCloneTrackItemAction(items[i], offset, vo, ao, kind === "V", false));
          }
        }
        project.executeTransaction((tx) => {
          for (const a of actions) tx.addAction(a);
        }, `agent: clone ${found} clip(s) at ${at}s to +${by.toFixed(3)}s`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }

    // Verify by re-reading: each source clip must now have a twin at start+by
    // on the expected destination track. The first read right after a commit
    // can be stale (same as splitAt), so wait and re-read before reporting a
    // failure the caller would then "fix" by cloning again.
    const readAfter = async () => {
      const rows = [];
      for (const { track, id } of tracks) {
        for (const it of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []) {
          if (!it) continue;
          const [st, en] = await Promise.all([it.getStartTime(), it.getEndTime()]);
          rows.push({ track: id, start: Number(st.seconds.toFixed(3)), end: Number(en.seconds.toFixed(3)) });
        }
      }
      return rows;
    };
    const destTrack = (b) => `${b.kind}${Number(b.track.slice(1)) + (b.kind === "V" ? vOffset : aOffset)}`;
    const check = (rows) => before.every((b) =>
      rows.some((a) => a.track === destTrack(b) && Math.abs(a.start - (b.start + by)) < 0.05));
    let after = await readAfter();
    let cloned = check(after);
    if (!err && !cloned) {
      await new Promise((res) => setTimeout(res, 1200));
      after = await readAfter();
      cloned = check(after);
    }
    return {
      ok: !err && cloned,
      error: err,
      clonedPairs: found,
      by,
      before: before.map((b) => ({ track: b.track, start: Number(b.start.toFixed(3)), end: Number(b.end.toFixed(3)) })),
      clips: after.sort((a, b) => a.start - b.start),
    };
  },

  /**
   * Retrims ONE clip, addressed by track and index: any of timeline start/end
   * (createSetStart/EndAction) and source in/out (createSetInPoint/OutPointAction)
   * in a single transaction. Also the probe surface for the undocumented
   * semantics of the in/out actions on a track item.
   */
  async "timeline.retrim"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const kind = String(params.track || "V0").slice(0, 1).toUpperCase();
    const idx = Number(String(params.track || "V0").slice(1));
    const track = kind === "A" ? await sequence.getAudioTrack(idx) : await sequence.getVideoTrack(idx);
    if (!track) throw new Error(`no track ${params.track}`);
    const index = params.index ?? 0;

    const readItem = async () => {
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
      const it = items[index];
      if (!it) return null;
      const [st, en, ip, op] = await Promise.all([
        it.getStartTime(), it.getEndTime(), it.getInPoint(), it.getOutPoint(),
      ]);
      return {
        start: Number(st.seconds.toFixed(4)), end: Number(en.seconds.toFixed(4)),
        inPoint: Number(ip.seconds.toFixed(4)), outPoint: Number(op.seconds.toFixed(4)),
      };
    };

    const before = await readItem();
    if (!before) throw new Error(`no clip at ${params.track}[${index}]`);

    const wanted = [
      ["startSeconds", "createSetStartAction"],
      ["endSeconds", "createSetEndAction"],
      ["inPointSeconds", "createSetInPointAction"],
      ["outPointSeconds", "createSetOutPointAction"],
    ].filter(([key]) => typeof params[key] === "number");
    if (!wanted.length) throw new Error("nothing to retrim: pass startSeconds/endSeconds/inPointSeconds/outPointSeconds");

    let err = null;
    try {
      project.lockedAccess(() => {
        const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
        const it = items[index];
        if (!it) throw new Error("clip vanished between read and lock");
        const actions = wanted.map(([key, method]) =>
          it[method](ppro.TickTime.createWithSeconds(params[key])));
        project.executeTransaction((tx) => {
          for (const a of actions) tx.addAction(a);
        }, `agent: retrim ${params.track}[${index}]`);
      });
    } catch (e) {
      err = e?.message || String(e);
    }

    const after = await readItem();
    return { ok: !err, error: err, track: params.track, index, before, after };
  },

  /**
   * Closes gaps between clips, shifting later content left.
   *
   * Ripple delete does not reliably butt the remaining clips together: cut
   * points snap to frame boundaries, leaving sub-frame residue, and larger
   * holes have been observed too. Rather than trusting ripple, this pass
   * measures the timeline and removes whatever gap is actually there.
   *
   * One gap per transaction, working left to right and re-reading each time, so
   * clips can never transiently overlap.
   */
  async "timeline.closeGaps"(params) {
    const project = await ppro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    const tolerance = params.toleranceSeconds ?? 0.001;
    const maxPasses = params.maxPasses ?? 64;

    const trackRefs = async () => {
      const [v, a] = await Promise.all([
        sequence.getVideoTrackCount(),
        sequence.getAudioTrackCount(),
      ]);
      const out = [];
      for (let i = 0; i < v; i++) out.push({ track: await sequence.getVideoTrack(i), id: `V${i}` });
      for (let i = 0; i < a; i++) out.push({ track: await sequence.getAudioTrack(i), id: `A${i}` });
      return out;
    };

    const tracks = await trackRefs();

    /** Clip rows per track with their index, sorted by start. */
    const read = async () => {
      const out = [];
      for (const { track, id } of tracks) {
        const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
        const rows = [];
        for (let i = 0; i < items.length; i++) {
          if (!items[i]) continue;
          const [st, en] = await Promise.all([items[i].getStartTime(), items[i].getEndTime()]);
          rows.push({ index: i, start: st.seconds, end: en.seconds });
        }
        rows.sort((a, b) => a.start - b.start);
        out.push({ id, rows });
      }
      return out;
    };

    const closed = [];
    for (let pass = 0; pass < maxPasses; pass++) {
      const state = await read();
      // Find the earliest gap across every populated track.
      let best = null;
      for (const t of state) {
        let cursor = 0;
        for (const r of t.rows) {
          const gap = r.start - cursor;
          if (gap > tolerance && (!best || r.start < best.at)) {
            best = { at: r.start, gap };
          }
          cursor = Math.max(cursor, r.end);
        }
      }
      if (!best) break;

      // Everything starting at or after the gap shifts left by its size.
      const toMove = {};
      for (const t of state) {
        toMove[t.id] = t.rows.filter((r) => r.start >= best.at - 1e-6).map((r) => r.index);
      }
      const shift = ppro.TickTime.createWithSeconds(-best.gap);
      try {
        project.lockedAccess(() => {
          const actions = [];
          for (const { track, id } of tracks) {
            const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
            for (const i of toMove[id] || []) {
              if (items[i]) actions.push(items[i].createMoveAction(shift));
            }
          }
          project.executeTransaction((tx) => {
            for (const a of actions) tx.addAction(a);
          }, `agent: close ${best.gap.toFixed(3)}s gap at ${best.at.toFixed(2)}s`);
        });
        closed.push({ at: Number(best.at.toFixed(3)), gap: Number(best.gap.toFixed(3)) });
      } catch (e) {
        return { ok: false, error: e?.message || String(e), closed };
      }
    }

    const final = await read();
    const v0 = final.find((t) => t.rows.length) || { rows: [] };
    const totalDuration = v0.rows.length ? v0.rows[v0.rows.length - 1].end : 0;
    const sumSegments = v0.rows.reduce((a, r) => a + (r.end - r.start), 0);
    return {
      ok: true,
      gapsClosed: closed.length,
      closed,
      segments: v0.rows.length,
      totalDuration: Number(totalDuration.toFixed(3)),
      sumSegments: Number(sumSegments.toFixed(3)),
      contiguous: Math.abs(totalDuration - sumSegments) < 0.01,
    };
  },

  /**
   * §4.1 — THE open probe. Dumps the transcript JSON schema so we can see
   * whether timings exist at word level or only per segment.
   */
  async "transcript.probe"(params) {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("no active project");
    const root = await project.getRootItem();
    const clips = await collectClipProjectItems(root);

    const withTranscript = [];
    for (const c of clips) {
      let has = false;
      try {
        has = ppro.Transcript.hasTranscript(c.clip);
      } catch (e) {
        /* older runtimes throw rather than returning false */
      }
      withTranscript.push({ name: c.name, id: c.id, hasTranscript: has });
    }

    const target = params.clipId
      ? withTranscript.find((c) => c.id === params.clipId)
      : withTranscript.find((c) => c.hasTranscript);
    if (!target) {
      return {
        clipsScanned: clips.length,
        clips: withTranscript,
        transcript: null,
        note: "No clip in this project has a transcript yet. Transcribe one in the Text panel, then re-run.",
      };
    }

    const clipObj = clips.find((c) => c.id === target.id).clip;
    const json = await ppro.Transcript.exportToJSON(clipObj);
    let parsed = null;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return { clipsScanned: clips.length, raw: json.slice(0, 2000), parseError: e.message };
    }

    return {
      clipsScanned: clips.length,
      clips: withTranscript,
      source: target.name,
      byteLength: json.length,
      schema: sketch(parsed),
      head: JSON.stringify(parsed).slice(0, Number(params.headBytes ?? 3000)),
    };
  },
};

/* --------------------------------------------------------------- dispatch */

async function handleCommand(msg) {
  const fn = commands[msg.command];
  if (!fn) {
    return { type: "response", id: msg.id, ok: false, error: `unknown command: ${msg.command}` };
  }
  try {
    const result = await fn(msg.params || {});
    return { type: "response", id: msg.id, ok: true, result };
  } catch (e) {
    return { type: "response", id: msg.id, ok: false, error: e?.message || String(e) };
  }
}

/* ------------------------------------------------------------- connection */

function connect() {
  clearTimeout(reconnectTimer);
  const url = ENDPOINTS[endpointIndex % ENDPOINTS.length];
  setStatus(`connecting to ${url}`, "wait");
  log(`connecting to ${url}`);

  try {
    ws = new WebSocket(url);
  } catch (e) {
    // A manifest permission rejection surfaces here — this is probe §4.5.
    log(`WebSocket construction failed: ${e.message}`, "err");
    log('if this is a permissions error, try "domains": "all" in manifest.json', "err");
    endpointIndex++;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
    return;
  }

  ws.onopen = () => {
    setStatus(`connected — ${url}`, "up");
    log(`connected to ${url}`, "ok");
    ws.send(JSON.stringify({ type: "register", role: "panel", app: "premierepro" }));
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return log("malformed message from proxy", "err");
    }
    if (msg.type === "registered") return log("registered with proxy", "ok");
    if (msg.type === "displaced") return log("displaced by another panel", "err");
    if (msg.type !== "command") return;

    log(`> ${msg.command}`);
    const response = await handleCommand(msg);
    log(response.ok ? `< ${msg.command} ok` : `< ${msg.command} failed: ${response.error}`,
        response.ok ? "ok" : "err");
    ws.send(JSON.stringify(response));
  };

  ws.onerror = () => log("socket error", "err");

  ws.onclose = () => {
    setStatus("disconnected", "down");
    log(`disconnected — retrying in ${RECONNECT_MS}ms`);
    endpointIndex++;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };
}

document.getElementById("reconnect").addEventListener("click", () => {
  if (ws) try { ws.close(); } catch {}
  endpointIndex = 0;
  connect();
});
document.getElementById("clear").addEventListener("click", () => { logEl.innerHTML = ""; });

connect();
