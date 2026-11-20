// 読む。シーケンス args.seq の、args.from〜args.to 秒にかかるクリップを、ビデオ args.v[] とオーディオ args.a[] から返す。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const C = ppro.Constants.TrackItemType;
const r3 = (x) => Math.round(x * 1000) / 1000;
async function dump(t) {
  const items = t.getTrackItems(C.CLIP, false) || [];
  const o = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const s = (await it.getStartTime()).seconds, e = (await it.getEndTime()).seconds;
    if (e <= args.from || s >= args.to) continue;
    o.push([i, await it.getName(), r3(s), r3(e), r3((await it.getInPoint()).seconds), r3((await it.getOutPoint()).seconds)]);
  }
  return o;
}
const out = { V: {}, A: {} };
for (const v of args.v || []) out.V[v] = await dump(await seq.getVideoTrack(v));
for (const a of args.a || []) out.A[a] = await dump(await seq.getAudioTrack(a));
return out;
