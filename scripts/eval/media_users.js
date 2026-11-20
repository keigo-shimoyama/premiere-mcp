// 読むだけ。素材パス(args.paths のどれか)を使っているクリップのシーケンス名と数を返す。
const seqs = await project.getSequences();
const out = {};
for (const sq of seqs) {
  const n = await sq.getVideoTrackCount();
  for (let ti = 0; ti < n; ti++) {
    const t = await sq.getVideoTrack(ti);
    for (const it of t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []) {
      let p = "";
      try { p = await ppro.ClipProjectItem.cast(await it.getProjectItem()).getMediaFilePath(); } catch (e) {}
      if ((args.paths || []).some((q) => p.endsWith(q))) { out[sq.name] = (out[sq.name] || 0) + 1; }
    }
  }
}
return out;
