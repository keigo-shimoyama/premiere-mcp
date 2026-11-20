// 名前で引いたシーケンス(args.seq)のオーディオトラック args.track の各クリップについて、ボリューム(レベル)のキーを点検し、
// args.apply なら「頭のキー(値 g)を残し、(out - fade, g) → (out, 0) の 2 点に打ち直す」。キーの時刻はメディアの時刻。
// 終わりのフェードが合っているクリップは触らない。args.only: [index...] で対象を絞れる。
// args: {seq, track: 3, fade: 2.0, apply: false, only: null}
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const t = await seq.getAudioTrack(args.track);
const fade = args.fade ?? 2.0;
const items = t.getTrackItems(C.CLIP, false) || [];
const out = [];
for (let i = 0; i < items.length; i++) {
  if (args.only && !args.only.includes(i)) continue;
  const it = items[i];
  const name = await it.getName();
  const inP = (await it.getInPoint()).seconds, outP = (await it.getOutPoint()).seconds;
  const p = (await it.getComponentChain()).getComponentAtIndex(0).getParam(1);
  const keys = [];
  for (const tk of (await p.getKeyframeListAsTickTimes()) || []) {
    const k = await p.getKeyframePtr(tk);
    keys.push({ s: tk.seconds, v: k.value?.value ?? k.value });
  }
  const g = keys.length ? Math.max(...keys.map((k) => k.v)) : null; // 頭のフェードイン(0 → g)があっても g は最大値
  const want = [[outP - fade, g], [outP, 0]];
  const tail = keys.filter((k) => k.s > inP + 1.0);
  const good = tail.length === 2 && Math.abs(tail[0].s - want[0][0]) < 0.02 && Math.abs(tail[1].s - want[1][0]) < 0.02 && tail[1].v === 0;
  const r = { i, name: name.slice(0, 14), s: (await it.getStartTime()).seconds, inP, outP, keys, good };
  if (args.apply && !good && g !== null) {
    try {
      project.lockedAccess(() => {
        const acts = [];
        acts.push(p.createRemoveKeyframeRangeAction(ppro.TickTime.createWithSeconds(inP + 1.0), ppro.TickTime.createWithSeconds(Math.max(outP, ...keys.map((k) => k.s)) + 1), true));
        for (const [ts, v] of want) {
          const kf = p.createKeyframe(v);
          kf.position = ppro.TickTime.createWithSeconds(ts);
          acts.push(p.createAddKeyframeAction(kf));
        }
        project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, `agent: BGM fade ${name.slice(0, 10)}`);
      });
      const after = [];
      for (const tk of (await p.getKeyframeListAsTickTimes()) || []) {
        const k = await p.getKeyframePtr(tk);
        after.push({ s: tk.seconds, v: k.value?.value ?? k.value });
      }
      r.after = after;
    } catch (e) { r.error = e?.message || String(e); }
  }
  out.push(r);
}
return out;
