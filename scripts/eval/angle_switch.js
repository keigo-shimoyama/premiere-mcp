// 書き込む。名前で引いたシーケンス(args.seq)で、開始 s(秒, ±0.02)の区間のアングルを from トラックから to トラックへ切り替える
// (from を無効、to を有効にする)。クリップは動かさない。
// args: {seq, dry, ops: [{s, from, to}]}
const seq = (await project.getSequences()).find((x) => x.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const find = async (k, s) => {
  const t = await seq.getVideoTrack(k);
  const items = t.getTrackItems(C.CLIP, false) || [];
  const hits = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) continue;
    if (Math.abs((await items[i].getStartTime()).seconds - s) < 0.02) hits.push({ i, name: await items[i].getName(), dis: await items[i].isDisabled() });
  }
  return { t, hits };
};
const plan = [];
for (const op of args.ops) {
  const f = await find(op.from, op.s), g = await find(op.to, op.s);
  if (f.hits.length !== 1 || g.hits.length !== 1) throw new Error(`not unique at ${op.s}: from ${f.hits.length}, to ${g.hits.length}`);
  if (f.hits[0].dis || !g.hits[0].dis) throw new Error(`unexpected state at ${op.s}: from dis=${f.hits[0].dis}, to dis=${g.hits[0].dis}`);
  plan.push({ op, f, g });
}
if (args.dry) return { dry: true, plan: plan.map((p) => [p.op.s, p.f.hits[0].name, "->", p.g.hits[0].name]) };
for (const p of plan) {
  project.lockedAccess(() => {
    const a = (p.f.t.getTrackItems(C.CLIP, false) || [])[p.f.hits[0].i].createSetDisabledAction(true);
    const b = (p.g.t.getTrackItems(C.CLIP, false) || [])[p.g.hits[0].i].createSetDisabledAction(false);
    project.executeTransaction((tx) => { tx.addAction(a); tx.addAction(b); }, `agent: angle ${p.op.s.toFixed(3)} V${p.op.from}->V${p.op.to}`);
  });
}
const after = [];
for (const p of plan) after.push([p.op.s, (await find(p.op.from, p.op.s)).hits[0].dis, (await find(p.op.to, p.op.s)).hits[0].dis]);
return { ok: true, after };
