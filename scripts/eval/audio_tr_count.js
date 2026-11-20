// 読む(args.setPlayer があれば再生ヘッドも動かす)。各オーディオトラックのトランジション数を返す。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (args.setPlayer !== undefined) await seq.setPlayerPosition(ppro.TickTime.createWithSeconds(args.setPlayer));
const out = {};
const n = await seq.getAudioTrackCount();
for (let i = 0; i < n; i++) {
  const t = await seq.getAudioTrack(i);
  out["A" + i] = (t.getTrackItems(ppro.Constants.TrackItemType.TRANSITION, false) || []).length;
}
out.player = (await seq.getPlayerPosition()).seconds;
return out;
