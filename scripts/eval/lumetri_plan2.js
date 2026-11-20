// args.phase="probe": args.src を 1 回複製し(アクティブは変えない)、複製の V(args.poolTrack) で Lumetri を持つクリップを
//   数値パラメータの値の組(署名)で分類して返す。
// args.phase="move": 複製 args.pool のトラック args.poolTrack から、名前が args.poolNames に入るクリップの Lumetri を外し、
//   args.dst のトラック args.dstTrack の全クリップへ 1 つずつ移す(1 トランザクション)。
const MATCH = "AE.ADBE Lumetri";
const C = ppro.Constants.TrackItemType;
const byName = async (n) => (await project.getSequences()).find((s) => s.name === n);
async function lumOf(item) {
  const chain = await item.getComponentChain();
  const n = chain.getComponentCount();
  for (let i = 0; i < n; i++) {
    const c = chain.getComponentAtIndex(i);
    if ((await c.getMatchName()) === MATCH) return { chain, comp: c, n };
  }
  return { chain, comp: null, n };
}
async function sig(comp) {
  const vals = [];
  const n = comp.getParamCount();
  for (let i = 1; i < n; i++) {
    let v = null;
    try { const k = await comp.getParam(i).getStartValue(); v = k && k.value !== undefined ? (k.value.value ?? k.value) : k; } catch (e) { v = "E"; }
    if (typeof v === "number") vals.push(Math.round(v * 1000) / 1000);
    else if (typeof v === "boolean") vals.push(v ? 1 : 0);
  }
  return vals.join(",");
}
if (args.phase === "probe") {
  const src = await byName(args.src);
  const before = new Set((await project.getSequences()).map((s) => String(s.guid)));
  project.lockedAccess(() => {
    project.executeTransaction((tx) => { tx.addAction(src.createCloneAction()); }, `agent: clone ${args.src} for Lumetri`);
  });
  const pool = (await project.getSequences()).find((s) => !before.has(String(s.guid)));
  const t = await pool.getVideoTrack(args.poolTrack);
  const groups = {};
  for (const it of t.getTrackItems(C.CLIP, false) || []) {
    const L = await lumOf(it);
    if (!L.comp) continue;
    const s = await sig(L.comp);
    (groups[s] = groups[s] || []).push(await it.getName());
  }
  return { pool: pool.name, poolGuid: String(pool.guid), groups: Object.values(groups) };
}
if (args.phase === "move") {
  const pool = await byName(args.pool), dst = await byName(args.dst);
  const pt = await pool.getVideoTrack(args.poolTrack), dt = await dst.getVideoTrack(args.dstTrack);
  const P = [];
  for (const it of pt.getTrackItems(C.CLIP, false) || []) {
    if (!args.poolNames.includes(await it.getName())) continue;
    const L = await lumOf(it);
    if (L.comp) P.push(L);
  }
  const D = [];
  for (const it of dt.getTrackItems(C.CLIP, false) || []) D.push(await lumOf(it));
  if (P.length < D.length) throw new Error(`pool ${P.length} < targets ${D.length}`);
  project.lockedAccess(() => {
    project.executeTransaction((tx) => {
      D.forEach((d, j) => {
        const p = P[j];
        if (d.comp) tx.addAction(d.chain.createRemoveComponentAction(d.comp));
        tx.addAction(p.chain.createRemoveComponentAction(p.comp));
        tx.addAction(d.chain.createAppendComponentAction(p.comp, d.comp ? d.n - 1 : d.n));
      });
    }, `agent: move Lumetri x${D.length} to ${args.dst} V${args.dstTrack}`);
  });
  let has = 0;
  for (const it of dt.getTrackItems(C.CLIP, false) || []) if ((await lumOf(it)).comp) has++;
  return { targets: D.length, withLumetri: has };
}
throw new Error("unknown phase");
