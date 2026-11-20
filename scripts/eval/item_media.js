// 読む。シーケンス args.seq のオーディオ args.a のクリップ args.items[] の素材パス。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const t = await seq.getAudioTrack(args.a);
const items = t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
const out = [];
for (const i of args.items) {
  const pi = await items[i].getProjectItem();
  const c = ppro.ClipProjectItem.cast(pi);
  out.push([i, await items[i].getName(), await c.getMediaFilePath()]);
}
return out;
