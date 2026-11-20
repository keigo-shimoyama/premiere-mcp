// 書き込む。シーケンス args.seq の V(args.v[]) と A(args.a[]) で、開始が args.cutS 秒のクリップ(素材がつながっている短い断片)を
// リップルなしで消し、直前のクリップ(終わりが args.cutS)の終わりを、消したクリップの終わりまで伸ばす。
// 1 回目のトランザクションで削除、2 回目で setEnd。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const C = ppro.Constants.TrackItemType;
const near = (a, b) => Math.abs(a - b) < 0.01;
const tracks = [];
for (const v of args.v) tracks.push(await seq.getVideoTrack(v));
for (const a of args.a) tracks.push(await seq.getAudioTrack(a));
const plan = [];
for (let k = 0; k < tracks.length; k++) {
  const items = tracks[k].getTrackItems(C.CLIP, false) || [];
  let prev = -1, cut = -1, endT = null;
  for (let i = 0; i < items.length; i++) {
    const s = (await items[i].getStartTime()).seconds, e = (await items[i].getEndTime());
    if (near(e.seconds, args.cutS)) prev = i;
    if (near(s, args.cutS)) { cut = i; endT = e.ticks; }
  }
  if (prev < 0 || cut < 0) throw new Error(`track ${k}: prev ${prev} cut ${cut}`);
  const prevName = await items[prev].getName(), cutName = await items[cut].getName();
  plan.push({ k, prev, cut, endT: String(endT), prevName, cutName });
}
project.lockedAccess(() => {
  const ed = ppro.SequenceEditor.getEditor(seq);
  let sel = null;
  ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
  for (const p of plan) sel.addItem((tracks[p.k].getTrackItems(C.CLIP, false) || [])[p.cut], true);
  const a = ed.createRemoveItemsAction(sel, false, (args.v.length ? ppro.Constants.MediaType.ANY : ppro.Constants.MediaType.AUDIO), false);
  project.executeTransaction((tx) => tx.addAction(a), `agent: FB7 remove fragment x${plan.length}`);
});
project.lockedAccess(() => {
  const acts = plan.map((p) => (tracks[p.k].getTrackItems(C.CLIP, false) || [])[p.prev].createSetEndAction(ppro.TickTime.createWithTicks(p.endT)));
  project.executeTransaction((tx) => { for (const x of acts) tx.addAction(x); }, `agent: FB7 extend x${acts.length}`);
});
const after = [];
for (let k = 0; k < tracks.length; k++) {
  const it = (tracks[k].getTrackItems(C.CLIP, false) || [])[plan[k].prev];
  after.push([k, await it.getName(), (await it.getStartTime()).seconds, (await it.getEndTime()).seconds, (await it.getInPoint()).seconds, (await it.getOutPoint()).seconds]);
}
return { plan, after };
