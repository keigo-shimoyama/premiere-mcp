// 書き込む。シーケンス args.seq の V(args.dst)で、開始フレームが args.removeF のクリップ(映像だけ)をリップルなしで消し、
// V(args.src)で開始フレームが args.cloneF のクリップを同じ時刻のまま V(args.dst)へ複製する(映像だけ)。
const TPF = 8475667200n;
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const C = ppro.Constants.TrackItemType;
const st = await seq.getVideoTrack(args.src), dt = await seq.getVideoTrack(args.dst);
const fr = async (it) => Number(BigInt((await it.getStartTime()).ticks) / TPF);
const idxOf = async (t, fs) => { const items = t.getTrackItems(C.CLIP, false) || []; const o = []; for (let i = 0; i < items.length; i++) if (fs.includes(await fr(items[i]))) o.push(i); return o; };
const rm = await idxOf(dt, args.removeF), cl = await idxOf(st, args.cloneF);
if (rm.length !== args.removeF.length || cl.length !== args.cloneF.length) throw new Error(`found rm ${rm} cl ${cl}`);
project.lockedAccess(() => {
  const ed = ppro.SequenceEditor.getEditor(seq);
  const di = dt.getTrackItems(C.CLIP, false) || [];
  let sel = null;
  ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
  for (const i of rm) sel.addItem(di[i], true);
  const a = ed.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.VIDEO, false);
  project.executeTransaction((tx) => tx.addAction(a), `agent: plan1 FB remove x${rm.length}`);
});
project.lockedAccess(() => {
  const ed = ppro.SequenceEditor.getEditor(seq);
  const si = st.getTrackItems(C.CLIP, false) || [];
  const zero = ppro.TickTime.createWithTicks("0");
  const acts = cl.map((i) => ed.createCloneTrackItemAction(si[i], zero, args.dst - args.src, 0, true, false));
  project.executeTransaction((tx) => { for (const x of acts) tx.addAction(x); }, `agent: plan1 FB clone x${acts.length}`);
});
const out = [];
for (const it of dt.getTrackItems(C.CLIP, false) || []) {
  const s = await fr(it);
  if (s > 3300 && s < 8200) out.push([await it.getName(), s, Number(BigInt((await it.getEndTime()).ticks) / TPF), Number(BigInt((await it.getInPoint()).ticks) / TPF)]);
}
return out;
