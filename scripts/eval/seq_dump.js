// 読むだけ。名前で引いたシーケンス(args.seq)の指定トラックのクリップ(と transition)を返す。
// args: {seq: "③横10分_荒編v6e", v: [5,6,7], a: [3], trans: true}
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const out = { v: {}, a: {} };
async function dumpTrack(t) {
  const r = [];
  const items = t.getTrackItems(C.CLIP, false) || [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    r.push({ i, name: await it.getName(), s: (await it.getStartTime()).seconds, e: (await it.getEndTime()).seconds,
      in: (await it.getInPoint()).seconds, out: (await it.getOutPoint()).seconds });
  }
  let tr = [];
  if (args.trans) {
    const ts = t.getTrackItems(C.TRANSITION, false) || [];
    for (const x of ts) {
      if (!x) { tr.push(null); continue; }
      const r2 = {};
      try { r2.s = (await x.getStartTime()).seconds; r2.e = (await x.getEndTime()).seconds; } catch (e) { r2.err = e.message; }
      tr.push(r2);
    }
  }
  return { items: r, trans: tr };
}
for (const i of args.v || []) out.v[i] = await dumpTrack(await seq.getVideoTrack(i));
for (const i of args.a || []) out.a[i] = await dumpTrack(await seq.getAudioTrack(i));
if (args.save) fs.writeFileSync ? fs.writeFileSync(args.save, JSON.stringify(out)) : null;
return out;
