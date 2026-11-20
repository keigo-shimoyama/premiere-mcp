// 読むだけ。コンポーネントチェーン・トラックアイテム・フィルタファクトリのメソッドと、Lumetri のパラメータ名を返す。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const C = ppro.Constants.TrackItemType;
const t4 = await seq.getVideoTrack(4);
const it = (t4.getTrackItems(C.CLIP, false) || [])[27];
const ch = await it.getComponentChain();
const out = { chain: methodsOf(ch), item: methodsOf(it), ppro: Object.keys(ppro).filter((k) => /Filter|Component|Lut|Effect|Factory/i.test(k)) };
for (const k of out.ppro) { try { out["m_" + k] = methodsOf(ppro[k]); } catch (e) {} }
const lum = ch.getComponentAtIndex(2);
out.comp = methodsOf(lum);
const params = [];
const n = lum.getParamCount();
for (let i = 0; i < n; i++) {
  const p = lum.getParam(i);
  let v = null;
  try { const k = await p.getStartValue(); v = k && k.value !== undefined ? (k.value.value ?? k.value) : k; if (typeof v === "object") v = JSON.stringify(v).slice(0, 80); } catch (e) { v = "ERR"; }
  params.push([i, p.displayName, v]);
}
out.params = params.filter((r) => r[1] && (/LUT|ルック|入力|Input|Look/i.test(r[1]) || typeof r[2] === "string"));
out.paramCount = n;
out.param0 = methodsOf(lum.getParam(0));
return out;
