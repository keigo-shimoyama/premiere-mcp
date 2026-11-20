// 読むだけ。名前で引いたシーケンス(args.seq)の全トラックの名前・クリップ数・ミュート/ロック、
// args.vTracks に挙げたビデオトラックはクリップの一覧(名前・開始・終了・in)も返す。
// args: {seq, vTracks: [4], aTracks: [0]}
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const out = { video: [], audio: [] };
const vc = await seq.getVideoTrackCount();
for (let i = 0; i < vc; i++) {
  const t = await seq.getVideoTrack(i);
  const items = t.getTrackItems(C.CLIP, false) || [];
  const row = { i, name: await t.name, n: items.length };
  try { row.muted = await t.isMuted(); } catch (e) {}
  if ((args.vTracks || []).includes(i)) {
    row.clips = [];
    for (const it of items) row.clips.push([await it.getName(), +(await it.getStartTime()).seconds.toFixed(3), +(await it.getEndTime()).seconds.toFixed(3), +(await it.getInPoint()).seconds.toFixed(3)]);
  }
  out.video.push(row);
}
const ac = await seq.getAudioTrackCount();
for (let i = 0; i < ac; i++) {
  const t = await seq.getAudioTrack(i);
  const items = t.getTrackItems(C.CLIP, false) || [];
  const row = { i, name: await t.name, n: items.length };
  if ((args.aTracks || []).includes(i)) {
    row.clips = [];
    for (const it of items) row.clips.push([await it.getName(), +(await it.getStartTime()).seconds.toFixed(3), +(await it.getEndTime()).seconds.toFixed(3), +(await it.getInPoint()).seconds.toFixed(3)]);
  }
  out.audio.push(row);
}
return out;
