// 読むだけ。アクティブなシーケンスの指定ビデオトラック・クリップの、コンポーネント(エフェクト)名を返す。
// args: {track: 4, items: [4, 9]}
const t = await sequence.getVideoTrack(args.track);
const items = t.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
const out = [];
for (const ii of args.items || []) {
  const it = items[ii];
  const ch = await it.getComponentChain();
  const comps = [];
  for (let ci = 0; ci < ch.getComponentCount(); ci++) {
    const c = ch.getComponentAtIndex(ci);
    comps.push(await c.getMatchName());
  }
  out.push({ ii, name: await it.getName(), comps });
}
return out;
