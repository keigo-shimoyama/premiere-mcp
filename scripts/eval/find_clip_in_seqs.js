// 読むだけ。名前に args.seq を含むシーケンスの全ビデオトラックから、名前か素材パスに args.q を含むクリップを返す。
// 開始・終了・インポイント・アウトポイント(秒)、エフェクト、Motion の値を含む。
const seqs = await project.getSequences();
const out = [];
for (const sq of seqs) {
  if (!(args.seq || []).some((s) => sq.name.includes(s))) continue;
  const n = await sq.getVideoTrackCount();
  for (let ti = 0; ti < n; ti++) {
    const t = await sq.getVideoTrack(ti);
    const items = t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = await it.getName();
      let path = "";
      try { path = await ppro.ClipProjectItem.cast(await it.getProjectItem()).getMediaFilePath(); } catch (e) {}
      if (!(args.q || []).some((q) => name.includes(q) || path.includes(q))) continue;
      const ch = await it.getComponentChain();
      const comps = [];
      for (let ci = 0; ci < ch.getComponentCount(); ci++) {
        const c = ch.getComponentAtIndex(ci);
        const mn = await c.getMatchName();
        const r = { mn };
        if (mn === "AE.ADBE Motion") {
          r.p = [];
          for (let pi = 0; pi < c.getParamCount(); pi++) {
            const p = c.getParam(pi);
            let v = null;
            try { const k = await p.getStartValue(); v = k && k.value !== undefined ? (k.value.value ?? k.value) : k; } catch (e) { v = "ERR"; }
            r.p.push([p.displayName, v]);
          }
        }
        comps.push(r);
      }
      out.push({ seq: sq.name, t: ti, i, name, path,
        s: (await it.getStartTime()).seconds, e: (await it.getEndTime()).seconds,
        inP: (await it.getInPoint()).seconds, outP: (await it.getOutPoint()).seconds, comps });
    }
  }
}
return out;
