// 書き込む。アクティブなシーケンスで、args.ranges の各 [a, b](秒)に収まる(±0.02 秒)クリップのうち、いま有効なものだけを無効にする。
// 全編にわたるクリップ(範囲より長いもの)は触らない。args.dry なら一覧だけ返す。
// args: {ranges: [[a, b], ...], dry: true, skipTracks: ["V10", "V14", "V15", "A4"]}
const C = ppro.Constants.TrackItemType;
const tol = 0.02;
const skip = new Set(args.skipTracks || []);
const hits = [];
for (const [k, n] of [["V", await sequence.getVideoTrackCount()], ["A", await sequence.getAudioTrackCount()]]) {
  for (let t = 0; t < n; t++) {
    if (skip.has(k + (t + 1))) continue;
    const tr = k === "V" ? await sequence.getVideoTrack(t) : await sequence.getAudioTrack(t);
    const items = (tr.getTrackItems(C.CLIP, false) || []).filter(Boolean);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const s = (await it.getStartTime()).seconds, e = (await it.getEndTime()).seconds;
      const r = args.ranges.find(([a, b]) => s >= a - tol && e <= b + tol);
      if (!r || (await it.isDisabled())) continue;
      hits.push({ k, t, i, tr: k + (t + 1), name: (await it.getName()).slice(0, 24), s: +s.toFixed(3), e: +e.toFixed(3) });
    }
  }
}
if (args.dry) return hits;
const byTrack = {};
for (const h of hits) (byTrack[h.tr] ||= []).push(h);
const done = [];
for (const [trName, hs] of Object.entries(byTrack)) {
  const h0 = hs[0];
  const tr = h0.k === "V" ? await sequence.getVideoTrack(h0.t) : await sequence.getAudioTrack(h0.t);
  const items = (tr.getTrackItems(C.CLIP, false) || []).filter(Boolean);
  project.lockedAccess(() => {
    const acts = hs.map((h) => items[h.i].createSetDisabledAction(true));
    project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, `agent: disable ${hs.length} on ${trName}`);
  });
  done.push(trName + ":" + hs.length);
}
return { done, hits };
