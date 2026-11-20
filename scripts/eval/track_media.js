// 読むだけ。アクティブなシーケンスの指定ビデオトラックの各クリップについて、名前・開始・終了・素材のパスを返す。
// args: {tracks: [5, 6], audio: false, methods: false}
const out = [];
let shown = false;
for (const ti of args.tracks || [0]) {
  const t = args.audio ? await sequence.getAudioTrack(ti) : await sequence.getVideoTrack(ti);
  const items = t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pi = await it.getProjectItem();
    const cpi = ppro.ClipProjectItem.cast(pi);
    let path = null;
    try { path = await cpi.getMediaFilePath(); } catch (e) { path = "ERR " + e.message; }
    if (args.methods && !shown) { shown = true; log("ClipProjectItem methods", methodsOf(cpi)); }
    out.push({ t: ti, i, name: await it.getName(), s: (await it.getStartTime()).seconds, e: (await it.getEndTime()).seconds, path });
  }
}
return out;
