// 読む。シーケンス args.seq のビデオ args.v で、args.times[] 秒にかかるクリップの名前・範囲・素材パス。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const t = await seq.getVideoTrack(args.v);
const items = t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
const out = [];
for (let i = 0; i < items.length; i++) {
  const s = (await items[i].getStartTime()).seconds, e = (await items[i].getEndTime()).seconds;
  if (!args.times.some((x) => x >= s && x < e)) continue;
  const c = ppro.ClipProjectItem.cast(await items[i].getProjectItem());
  out.push([i, await items[i].getName(), s, e, await c.getMediaFilePath()]);
}
return out;
