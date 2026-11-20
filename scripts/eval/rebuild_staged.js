// 書き込む(stage による)。rebuild_segments.js を段階ごとに分けたもの。1 回の呼び出しを短くし、計画をファイルに保存して再開できる。
// 既存アイテムは動かさない(複製・切り詰め・削除だけ。api-traps §5a)。
// args: {seq, planFile, stage, tracks?:[...] (対象トラックを絞る), ...plan 用の引数(rebuild_segments.js と同じ)}
// stage: "plan" | "park" | "trimEnd" | "trimStart" | "verify" | "removeOrig" | "place" | "verifyPlace" | "unpark" | "finish" | "status"
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const TPF = 8475667200n;
const T = (ticks) => ppro.TickTime.createWithTicks(String(ticks));
const tk = async (p) => BigInt(String((await p).ticks));
const sec = (t) => Number(t) / 254016000000;
const BGM_TRACK = "A3";

const tracks = [];
const vc = await seq.getVideoTrackCount(), ac = await seq.getAudioTrackCount();
for (let i = 0; i < vc; i++) tracks.push({ id: "V" + i, t: await seq.getVideoTrack(i) });
for (let i = 0; i < ac; i++) tracks.push({ id: "A" + i, t: await seq.getAudioTrack(i) });
const byId = Object.fromEntries(tracks.map((x) => [x.id, x]));
async function read(tr) {
  const items = tr.t.getTrackItems(C.CLIP, false) || [];
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) continue;
    rows.push({ i, name: await items[i].getName(), s: await tk(items[i].getStartTime()), e: await tk(items[i].getEndTime()) });
  }
  return rows;
}
const LIMIT = args.limit || 80;
const commitTrack = (id, pairs, label) => {
  pairs = pairs.slice(0, LIMIT);
  if (!pairs.length) return 0;
  project.lockedAccess(() => {
    const editor = ppro.SequenceEditor.getEditor(seq);
    const items = byId[id].t.getTrackItems(C.CLIP, false) || [];
    const acts = pairs.map(([i, make]) => make(items[i], editor));
    project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, label);
  });
  return pairs.length;
};
const removeTrack = (id, idxs, label) => {
  idxs = idxs.slice(0, LIMIT);
  if (!idxs.length) return 0;
  project.lockedAccess(() => {
    const items = byId[id].t.getTrackItems(C.CLIP, false) || [];
    let sel = null;
    ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
    if (!sel) throw new Error("no selection");
    for (const i of idxs) sel.addItem(items[i], true);
    const act = ppro.SequenceEditor.getEditor(seq).createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false);
    project.executeTransaction((tx) => { tx.addAction(act); }, label);
  });
  return idxs.length;
};
const t0 = Date.now();
const label = "agent: rebuild koba";

if (args.stage === "plan") {
  let tEnd = 0n;
  for (const tr of tracks) { tr.rows = await read(tr); for (const r of tr.rows) if (r.e > tEnd) tEnd = r.e; }
  const P = (tEnd / TPF + 1800n) * TPF;
  const excl = new Set(args.exclude || []);
  const pieces = [];
  for (const sg of args.segs) {
    const a = BigInt(sg.a) * TPF, b = BigInt(sg.b) * TPF, N = BigInt(sg.N) * TPF;
    for (const tr of tracks) {
      if (excl.has(tr.id) || (sg.skipTracks || []).includes(tr.id)) continue;
      const ext = (sg.extendHead || []).includes(tr.id);
      const covered = tr.rows.some((r) => r.s <= a && r.e > a);
      let first = null;
      for (const r of tr.rows) {
        if (!(r.s < b && r.e > a)) continue;
        if (r.s < a && (sg.skipEarlyAll || (sg.skipEarly || []).includes(tr.id))) continue;
        const pc = { tr: tr.id, name: r.name, rs: r.s, re: r.e, ps: r.s > a ? r.s : a, pe: r.e < b ? r.e : b, seg: sg.n, a, N };
        pieces.push(pc);
        if (ext && !covered && r.s > a && (!first || r.s < first.rs)) first = pc;
      }
      if (first) first.ps = a;
    }
  }
  for (const p of pieces) { p.fs = p.N + (p.ps - p.a); p.fe = p.N + (p.pe - p.a); delete p.a; delete p.N; }
  const bt = tracks.find((x) => x.id === BGM_TRACK);
  for (const bg of args.bgm || []) {
    const src = BigInt(bg.src) * TPF, len = BigInt(bg.len) * TPF, N = BigInt(bg.N) * TPF;
    const r = bt.rows.find((x) => x.s === src);
    if (!r) throw new Error("bgm source not found at frame " + bg.src);
    pieces.push({ tr: BGM_TRACK, name: r.name, rs: r.s, re: r.e, ps: r.s, pe: r.s + len, fs: N, fe: N + len, seg: "BGM" });
  }
  const cursor = {};
  for (const p of pieces) {
    const c = cursor[p.tr] ?? P;
    const lead = p.rs > p.ps ? p.rs - p.ps : 0n;
    p.slot = c + lead;
    const tailEnd = p.pe > p.re ? p.pe : p.re;
    cursor[p.tr] = p.slot + (tailEnd - p.rs) + 300n * TPF;
  }
  const ser = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? "b" + v.toString() : v));
  const procTracks = tracks.filter((x) => !excl.has(x.id) || x.id === BGM_TRACK).map((x) => x.id);
  fs.writeFileSync(args.planFile, ser({ P, total: BigInt(args.total) * TPF, pieces, procTracks, fullLen: args.fullLen, disable: args.disable }));
  const cnt = {};
  for (const p of pieces) cnt[p.tr] = (cnt[p.tr] || 0) + 1;
  return { planned: pieces.length, cnt, P: sec(P), ms: Date.now() - t0 };
}

const plan = JSON.parse(String(fs.readFileSync(args.planFile, "utf8")), (k, v) => (typeof v === "string" && /^b-?\d+$/.test(v) ? BigInt(v.slice(1)) : v));
const P = plan.P;
const want = args.tracks || plan.procTracks;
const res = {};

for (const id of want) {
  const tr = byId[id];
  const keep = new Set(args.keepNames || []);
  const mine = plan.pieces.filter((p) => p.tr === id && !keep.has(p.name));
  const rows = await read(tr);
  const orig = rows.filter((r) => r.s < P - TPF), parked = rows.filter((r) => r.s >= P - TPF);
  const origDel = orig.filter((r) => !keep.has(r.name));
  const TOL = id[0] === "A" ? TPF / 2n : 0n;
  const near = (a, b) => (a > b ? a - b : b - a) <= TOL;
  const at = (s, e) => parked.find((x) => near(x.s, s) && (e === undefined || near(x.e, e)));
  if (args.stage === "park") {
    const pairs = [];
    let skipped = 0;
    for (const p of mine) {
      if (at(p.slot)) { skipped++; continue; }
      const r = orig.find((x) => x.s === p.rs && x.e === p.re);
      if (!r) throw new Error(`${id}: original not found ${p.name} ${sec(p.rs)}`);
      pairs.push([r.i, (it, ed) => ed.createCloneTrackItemAction(it, T(p.slot - p.rs), 0, 0, id[0] === "V", false)]);
    }
    res[id] = { cloned: commitTrack(id, pairs, label + " park " + id), skipped };
  } else if (args.stage === "trimEnd") {
    const pairs = [];
    for (const p of mine) {
      const r = at(p.slot); if (!r) throw new Error(`${id}: parked missing ${p.name}`);
      const w = p.slot + (p.pe - p.rs);
      if (!near(r.e, w)) pairs.push([r.i, (it) => it.createSetEndAction(T(w - p.slot + r.s))]);
    }
    res[id] = commitTrack(id, pairs, label + " trimEnd " + id);
  } else if (args.stage === "trimStart") {
    const pairs = [];
    for (const p of mine) {
      const w = p.slot + (p.ps - p.rs);
      if (w === p.slot || at(w)) continue;
      const r = at(p.slot); if (!r) throw new Error(`${id}: parked missing ${p.name}`);
      pairs.push([r.i, (it) => it.createSetStartAction(T(r.s + (w - p.slot)))]);
    }
    res[id] = commitTrack(id, pairs, label + " trimStart " + id);
  } else if (args.stage === "verify") {
    const bad = mine.filter((p) => !at(p.slot + (p.ps - p.rs), p.slot + (p.pe - p.rs))).map((p) => [p.name, sec(p.fs)]);
    res[id] = { n: mine.length, parked: parked.length, bad: bad.slice(0, 5), nbad: bad.length };
  } else if (args.stage === "removeOrig") {
    res[id] = removeTrack(id, origDel.map((r) => r.i), label + " removeOrig " + id);
  } else if (args.stage === "place") {
    const pairs = [];
    let skipped = 0;
    for (const p of mine) {
      if (orig.find((x) => near(x.s, p.fs))) { skipped++; continue; }
      const s = p.slot + (p.ps - p.rs);
      const r = at(s); if (!r) throw new Error(`${id}: parked missing ${p.name}`);
      pairs.push([r.i, (it, ed) => ed.createCloneTrackItemAction(it, T(p.fs - r.s), 0, 0, id[0] === "V", false)]);
    }
    res[id] = { placed: commitTrack(id, pairs, label + " place " + id), skipped };
  } else if (args.stage === "placeMove") {
    // 退避した(切り詰め済みの)ピースを、左から順に最終位置へ移動する。順番が入れ替わらない(§5a の安全なずらし)。
    // 元の位置は removeOrig で空になっている前提。allowTraps: true が要る。
    const stray = origDel.filter((r) => !mine.some((p) => near(r.s, p.fs) && near(r.e, p.fe)));
    if (stray.length && !args.force) throw new Error(`${id}: originals still present (${stray.length})`);
    const srt = mine.slice().sort((x, y) => (x.slot < y.slot ? -1 : 1));
    const todo = [];
    let skipped = 0;
    for (const p of srt) {
      if (orig.find((x) => near(x.s, p.fs) && near(x.e, p.fe))) { skipped++; continue; }
      const s = p.slot + (p.ps - p.rs);
      const r = at(s, p.slot + (p.pe - p.rs)); if (!r) throw new Error(`${id}: parked missing ${p.name} ${sec(p.fs)}`);
      todo.push([r.i, p.fs - r.s]);
    }
    const pairs = todo.slice(0, LIMIT).map(([i, off]) => [i, (it) => it.createMoveAction(T(off))]);
    res[id] = { moved: commitTrack(id, pairs, label + " placeMove " + id), skipped, left: todo.length - pairs.length };
  } else if (args.stage === "verifyPlace") {
    const miss = mine.filter((p) => !orig.find((x) => near(x.s, p.fs) && near(x.e, p.fe))).map((p) => [p.name, sec(p.fs)]);
    const srt = orig.slice().sort((x, y) => (x.s < y.s ? -1 : 1));
    const over = [];
    for (let k = 1; k < srt.length; k++) if (srt[k].s < srt[k - 1].e) over.push([srt[k - 1].name, srt[k].name, sec(srt[k].s)]);
    let unsorted = 0;
    for (let k = 1; k < rows.length; k++) if (rows[k].s < rows[k - 1].s) unsorted++;
    res[id] = { n: orig.length, want: mine.length, miss: miss.slice(0, 5), nmiss: miss.length, over: over.slice(0, 3), unsorted };
  } else if (args.stage === "unpark") {
    res[id] = removeTrack(id, parked.map((r) => r.i), label + " unpark " + id);
  } else if (args.stage === "status") {
    res[id] = { orig: orig.length, parked: parked.length, want: mine.length };
  }
}
if (args.stage === "finish") {
  for (const id of plan.fullLen || []) {
    const rows = await read(byId[id]);
    res["end_" + id] = commitTrack(id, rows.filter((r) => r.e > plan.total).map((r) => [r.i, (it) => it.createSetEndAction(T(plan.total))]), label + " fullLen " + id);
  }
  for (const id of plan.disable || []) {
    const rows = await read(byId[id]);
    res["dis_" + id] = commitTrack(id, rows.map((r) => [r.i, (it) => it.createSetDisabledAction(true)]), label + " disable " + id);
  }
  res.seqEnd = (await seq.getEndTime()).seconds;
}
res.ms = Date.now() - t0;
return res;
