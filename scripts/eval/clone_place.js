// 書き込む。アクティブなシーケンスで、既存クリップ(エフェクト・LUT ごと)を複製し、素材の X 秒がタイムライン T 秒に来るように置いて、
// [T, end] に切りそろえる。複製は「伸ばす操作 → 縮める操作」の順に行い、途中で通る範囲が空いていなければ何もしない。
// args: {dry, ops: [{label, src: {track, name, s}, dst, X, T, end, blur?}]}
//   src.track / dst: ビデオトラック番号(0 始まり)。src.s: 元クリップの開始秒(±0.05)。blur: 数値ならガウスブラー(レガシ)を足す。
const C = ppro.Constants.TrackItemType;
const T = (s) => ppro.TickTime.createWithSeconds(s);
const items = async (t) => (((await sequence.getVideoTrack(t)).getTrackItems(C.CLIP, false)) || []).filter(Boolean);
const span = async (it) => [(await it.getStartTime()).seconds, (await it.getEndTime()).seconds];
const res = [];
for (const op of args.ops) {
  let src = null;
  for (const it of await items(op.src.track)) {
    const [s] = await span(it);
    if (Math.abs(s - op.src.s) < 0.05 && (await it.getName()) === op.src.name) src = it;
  }
  if (!src) { res.push({ label: op.label, error: "src not found" }); continue; }
  const [ss, se] = await span(src);
  const inP = (await src.getInPoint()).seconds;
  const S1 = op.T - (op.X - inP), E1 = S1 + (se - ss);
  const lo = Math.min(S1, op.T), hi = Math.max(E1, op.end);
  const block = [];
  for (const it of await items(op.dst)) {
    const [s, e] = await span(it);
    if (s < hi - 0.001 && e > lo + 0.001) block.push([(await it.getName()).slice(0, 24), +s.toFixed(3), +e.toFixed(3)]);
  }
  const row = { label: op.label, S1: +S1.toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), block };
  if (block.length || args.dry) { res.push(row); continue; }
  const before = new Set();
  for (const it of await items(op.dst)) before.add((await it.getStartTime()).ticks);
  project.lockedAccess(() => {
    const ed = ppro.SequenceEditor.getEditor(sequence);
    const a = ed.createCloneTrackItemAction(src, T(S1 - ss), op.dst - op.src.track, 0, true, false);
    project.executeTransaction((tx) => tx.addAction(a), `agent: clone ${op.label}`);
  });
  const find = async () => {
    for (const it of await items(op.dst)) {
      const [s, e] = await span(it);
      if (s < hi - 0.001 && e > lo + 0.001) return it;
    }
    return null;
  };
  let c = await find();
  if (!c) { row.error = "clone not found"; res.push(row); break; }
  const steps = [];
  if (op.T < S1 - 0.001) steps.push(["start", op.T]);
  if (op.end > E1 + 0.001) steps.push(["end", op.end]);
  if (op.end < E1 - 0.001) steps.push(["end", op.end]);
  if (op.T > S1 + 0.001) steps.push(["start", op.T]);
  const done = new Set();
  for (const [k, v] of steps) {
    const key = k + v;
    if (done.has(key)) continue;
    done.add(key);
    c = await find();
    project.lockedAccess(() => {
      const a = k === "start" ? c.createSetStartAction(T(v)) : c.createSetEndAction(T(v));
      project.executeTransaction((tx) => tx.addAction(a), `agent: ${k} ${op.label}`);
    });
  }
  c = await find();
  if (typeof op.blur === "number") {
    const comp = await ppro.VideoFilterFactory.createComponent("AE.ADBE Gaussian Blur 2");
    const chain = await c.getComponentChain();
    const n = chain.getComponentCount();
    project.lockedAccess(() => {
      project.executeTransaction((tx) => tx.addAction(chain.createInsertComponentAction ? chain.createInsertComponentAction(comp, n - 1) : chain.createAppendComponentAction(comp, n - 1)), `agent: blur ${op.label}`);
    });
    const ch2 = await c.getComponentChain();
    for (let i = 0; i < ch2.getComponentCount(); i++) {
      const cc = ch2.getComponentAtIndex(i);
      if ((await cc.getMatchName()) !== "AE.ADBE Gaussian Blur 2") continue;
      const p = cc.getParam(0);
      project.lockedAccess(() => {
        const kf = p.createKeyframe(op.blur);
        project.executeTransaction((tx) => tx.addAction(p.createSetValueAction(kf, true)), `agent: blur value ${op.label}`);
      });
      const v = await p.getStartValue();
      row.blur = v?.value?.value ?? v?.value;
    }
  }
  const [cs, ce] = await span(c);
  row.now = [await c.getName(), +cs.toFixed(3), +ce.toFixed(3), +(await c.getInPoint()).seconds.toFixed(3)];
  const comps = [];
  const ch = await c.getComponentChain();
  for (let i = 0; i < ch.getComponentCount(); i++) comps.push(await ch.getComponentAtIndex(i).getMatchName());
  row.comps = comps.join(",");
  res.push(row);
}
return res;
