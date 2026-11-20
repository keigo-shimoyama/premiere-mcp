// 読むだけ。指定トラックのクリップ一覧、V4 先頭付近のクリップのエフェクト、シーケンス/エディタのメソッド一覧を返す。
// args: {seq, vTracks:[...], fxTrack:4, fxIdx:[1,5]}
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const out = { tracks: {}, fx: [], methods: {} };
for (const ti of args.vTracks || []) {
  const t = await seq.getVideoTrack(ti);
  const rows = [];
  for (const it of t.getTrackItems(C.CLIP, false) || []) rows.push([await it.getName(), +(await it.getStartTime()).seconds.toFixed(3), +(await it.getEndTime()).seconds.toFixed(3)]);
  out.tracks[ti] = rows.slice(0, 6);
}
const t4 = await seq.getVideoTrack(args.fxTrack ?? 4);
const items = t4.getTrackItems(C.CLIP, false) || [];
for (const ix of args.fxIdx || [1]) {
  const it = items[ix];
  const ch = await it.getComponentChain();
  const comps = [];
  for (let i = 0; i < ch.getComponentCount(); i++) {
    const c = ch.getComponentAtIndex(i);
    comps.push([await c.getMatchName(), await c.getDisplayName()]);
  }
  const pi = await it.getProjectItem();
  let media = null;
  try { const cp = ppro.ClipProjectItem.cast(pi); media = await cp.getMediaFilePath(); } catch (e) { media = "ERR " + e.message; }
  out.fx.push({ name: await it.getName(), pname: pi.name, media, comps });
}
out.methods.sequence = methodsOf(seq);
project.lockedAccess(() => { out.methods.editor = methodsOf(ppro.SequenceEditor.getEditor(seq)); });
out.methods.videoTrack = methodsOf(t4);
return out;
