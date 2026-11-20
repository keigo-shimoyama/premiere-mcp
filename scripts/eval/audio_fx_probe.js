// 読むだけ。オーディオトラックの指定クリップのコンポーネントとパラメータ、キーフレームを返す。
// args: {track: 3, items: [0, 1, 10]}
// args.seq があれば、アクティブではなくその名前のシーケンスを読む。
const seqX = args.seq ? (await project.getSequences()).find((s) => s.name === args.seq) : sequence;
if (!seqX) throw new Error("sequence not found: " + args.seq);
const t = await seqX.getAudioTrack(args.track);
const items = t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
const out = [];
for (const ii of args.items || [0]) {
  const it = items[ii];
  const ch = await it.getComponentChain();
  const comps = [];
  for (let ci = 0; ci < ch.getComponentCount(); ci++) {
    const c = ch.getComponentAtIndex(ci);
    const ps = [];
    for (let pi = 0; pi < c.getParamCount(); pi++) {
      const p = c.getParam(pi);
      const r = { pi, name: p.displayName };
      try { r.tv = p.isTimeVarying(); } catch (e) {}
      try {
        if (r.tv) {
          const kl = p.getKeyframeListAsTickTimes ? await p.getKeyframeListAsTickTimes() : null;
          r.keys = [];
          for (const tt of kl || []) {
            const k = await p.getKeyframePtr(tt);
            r.keys.push({ s: tt.seconds, v: k && k.value !== undefined ? (k.value.value ?? k.value) : null });
          }
        } else {
          const k = await p.getStartValue();
          r.v = k && k.value !== undefined ? (k.value.value ?? k.value) : k;
        }
      } catch (e) { r.err = e.message; }
      if (!args.methods && ci === 0 && pi === 0) {}
      ps.push(r);
    }
    comps.push({ ci, match: await c.getMatchName(), name: await c.getDisplayName(), ps });
  }
  out.push({ ii, name: await it.getName(), s: (await it.getStartTime()).seconds, e: (await it.getEndTime()).seconds, comps });
}
if (args.methods) {
  const c = (await items[0].getComponentChain()).getComponentAtIndex(0);
  log("param methods", methodsOf(c.getParam(0)));
}
return out;
