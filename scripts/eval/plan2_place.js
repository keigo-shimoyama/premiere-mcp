// 書き込む。名前で引いたシーケンス args.seq のビデオトラック args.v(とオーディオ args.a)に、jobs のクリップを
// 「仮置き → 切り出し → 所定位置へ複製 → 仮置きを削除」で並べる。並べ替えの move は使わない(api-traps §5a)。
// args: {seq, v, a, phase: "park"|"trim"|"place"|"unpark"|"name"|"read", jobs:[{pid, X, T, dur, P, name}], trackName}
// X/T/dur/P はフレーム(29.97)。P は仮置きの位置、X は素材の頭、T はタイムライン上の頭、dur は尺。
const TPF = 8475667200n;
const tk = (f) => ppro.TickTime.createWithTicks(String(BigInt(f) * TPF));
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const vt = await seq.getVideoTrack(args.v);
const at = await seq.getAudioTrack(args.a);
const jobs = args.jobs;
const frOf = (t) => Number(BigInt(t.ticks) / TPF); // 端数は切り捨て(配置はフレーム境界)
async function read(track) {
  const items = track.getTrackItems(C.CLIP, false) || [];
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const s = await it.getStartTime(), e = await it.getEndTime(), ip = await it.getInPoint();
    rows.push({ i, name: await it.getName(), s: frOf(s), e: frOf(e), inF: frOf(ip), sT: BigInt(s.ticks), inT: BigInt(ip.ticks) });
  }
  return rows;
}
const ser = (rows) => rows.map((r) => [r.i, r.name, r.s, r.e, r.inF]);

if (args.phase === "read") return { v: ser(await read(vt)), a: ser(await read(at)) };

if (args.phase === "park") {
  const root = await project.getRootItem();
  const found = await collectClipProjectItems(root);
  const byId = Object.fromEntries(found.map((c) => [c.id, c]));
  for (const j of jobs) if (!byId[j.pid]) throw new Error("no project item " + j.pid);
  project.lockedAccess(() => {
    const ed = ppro.SequenceEditor.getEditor(seq);
    const acts = jobs.map((j) => ed.createOverwriteItemAction(ppro.ProjectItem.cast(byId[j.pid].clip), tk(j.P), args.v, args.a));
    project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, `agent: park plan2 x${jobs.length}`);
  });
  return { v: ser(await read(vt)), a: ser(await read(at)) };
}

// 仮置き(P 以降)にあるクリップを jobs と対応づける
function match(rows) {
  const out = [];
  for (const j of jobs) {
    const r = rows.find((x) => x.s >= j.P - 1 && x.s <= j.P + j.X + 1 && x.s >= args.parkFrom);
    out.push(r || null);
  }
  return out;
}

if (args.phase === "trim") {
  const V = await read(vt), A = await read(at);
  const mv = match(V), ma = match(A);
  const plan = [];
  jobs.forEach((j, k) => {
    for (const [rows, r, kind] of [[V, mv[k], "V"], [A, ma[k], "A"]]) {
      if (!r) { plan.push({ no: j.no, kind, error: "parked item not found" }); continue; }
      // src = t + (in - start)  →  素材 X が来るタイムライン位置 = start + (X - in)
      const ns = r.sT + BigInt(j.X) * TPF - r.inT;
      const ne = ns + BigInt(j.dur) * TPF;
      plan.push({ no: j.no, kind, i: r.i, ns, ne });
    }
  });
  const bad = plan.filter((p) => p.error);
  if (bad.length) return { bad };
  // 1 回目: 終わり、2 回目: 頭
  for (const which of ["ne", "ns"]) {
    project.lockedAccess(() => {
      const vi = vt.getTrackItems(C.CLIP, false) || [];
      const ai = at.getTrackItems(C.CLIP, false) || [];
      const acts = plan.map((p) => {
        const it = (p.kind === "V" ? vi : ai)[p.i];
        const t = ppro.TickTime.createWithTicks(String(p[which]));
        return which === "ne" ? it.createSetEndAction(t) : it.createSetStartAction(t);
      });
      project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, `agent: plan2 trim ${which} x${acts.length}`);
    });
  }
  return { v: ser(await read(vt)), a: ser(await read(at)) };
}

if (args.phase === "place") {
  const V = (await read(vt)).filter((r) => r.s >= args.parkFrom);
  const A = (await read(at)).filter((r) => r.s >= args.parkFrom);
  if (V.length !== jobs.length || A.length !== jobs.length) throw new Error(`parked count V${V.length} A${A.length} != ${jobs.length}`);
  project.lockedAccess(() => {
    const ed = ppro.SequenceEditor.getEditor(seq);
    const vi = vt.getTrackItems(C.CLIP, false) || [];
    const ai = at.getTrackItems(C.CLIP, false) || [];
    const acts = [];
    jobs.forEach((j, k) => {
      const offV = ppro.TickTime.createWithTicks(String(BigInt(j.T) * TPF - V[k].sT));
      const offA = ppro.TickTime.createWithTicks(String(BigInt(j.T) * TPF - A[k].sT));
      acts.push(ed.createCloneTrackItemAction(vi[V[k].i], offV, 0, 0, true, false));
      acts.push(ed.createCloneTrackItemAction(ai[A[k].i], offA, 0, 0, false, false));
    });
    project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, `agent: plan2 clone into slots x${jobs.length}`);
  });
  return { v: ser(await read(vt)), a: ser(await read(at)) };
}

if (args.phase === "unpark") {
  const V = (await read(vt)).filter((r) => r.s >= args.parkFrom);
  const A = (await read(at)).filter((r) => r.s >= args.parkFrom);
  project.lockedAccess(() => {
    const ed = ppro.SequenceEditor.getEditor(seq);
    const vi = vt.getTrackItems(C.CLIP, false) || [];
    const ai = at.getTrackItems(C.CLIP, false) || [];
    let sel = null;
    ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
    for (const r of V) sel.addItem(vi[r.i], true);
    for (const r of A) sel.addItem(ai[r.i], true);
    const act = ed.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false);
    project.executeTransaction((tx) => tx.addAction(act), `agent: plan2 remove parked x${V.length + A.length}`);
  });
  return { v: ser(await read(vt)), a: ser(await read(at)) };
}

if (args.phase === "name") {
  const V = await read(vt);
  project.lockedAccess(() => {
    const vi = vt.getTrackItems(C.CLIP, false) || [];
    const acts = [];
    jobs.forEach((j) => {
      const r = V.find((x) => x.s === j.T);
      if (r) acts.push(vi[r.i].createSetNameAction(j.name));
    });
    if (args.trackName) acts.push(vt.createSetNameAction(args.trackName));
    project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, `agent: plan2 names x${acts.length}`);
  });
  return { track: await vt.name, v: ser(await read(vt)) };
}
throw new Error("unknown phase " + args.phase);
