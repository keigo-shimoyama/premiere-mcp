// 読むだけ。指定シーケンスの各ビデオトラックについて、Lumetri を持つクリップ数と、先頭クリップの Lumetri の
// パラメータ(index と値。Blob は読めないので除く)を返す。
// args: {seq: "<シーケンス名>", tracks: [0,1,...], params: [6,14,15,16]}
const seqs = await project.getSequences();
const seq = seqs.find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const out = [];
for (const ti of args.tracks || [0]) {
  const t = await seq.getVideoTrack(ti);
  const items = t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
  let n = 0, first = null;
  for (const it of items) {
    const ch = await it.getComponentChain();
    for (let i = 0; i < ch.getComponentCount(); i++) {
      const c = ch.getComponentAtIndex(i);
      if ((await c.getMatchName()) !== "AE.ADBE Lumetri") continue;
      n++;
      if (!first) {
        first = {};
        for (const pi of args.params || []) {
          const p = c.getParam(pi);
          let v = null;
          try { const k = await p.getStartValue(); v = k && k.value !== undefined ? (k.value.value ?? k.value) : k; } catch (e) { v = "ERR " + e.message; }
          first[pi] = v;
        }
      }
    }
  }
  out.push({ track: ti, clips: items.length, withLumetri: n, firstParams: first });
}
return out;
