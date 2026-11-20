// 書き込む。シーケンス args.seq のオーディオ args.a で、開始 args.startS 秒のクリップを
// 仮置き(args.parkS 秒)へ複製 → 元を削除(リップルなし) → 仮置きを元の位置へ複製 → 仮置きを削除、の順で作り直す。
// クリップに付いたトランジションを外すため。トランザクションは 4 つ。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const C = ppro.Constants.TrackItemType;
const t = await seq.getAudioTrack(args.a);
const list = () => t.getTrackItems(C.CLIP, false) || [];
const findAt = async (sec) => { const it = list(); for (let i = 0; i < it.length; i++) if (Math.abs((await it[i].getStartTime()).seconds - sec) < 0.01) return i; return -1; };
const info = async (i) => { const it = list()[i]; return [await it.getName(), (await it.getStartTime()).ticks, (await it.getEndTime()).ticks, (await it.getInPoint()).ticks, (await it.getOutPoint()).ticks]; };
let i0 = await findAt(args.startS);
if (i0 < 0) throw new Error("not found");
const before = await info(i0);
const startT = BigInt(before[1]);
const parkT = BigInt(Math.round(args.parkS * 30000 / 1001)) * 8475667200n;
const remove = (idx, label) => project.lockedAccess(() => {
  const ed = ppro.SequenceEditor.getEditor(seq);
  let sel = null;
  ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
  sel.addItem(list()[idx], true);
  const a = ed.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.AUDIO, false);
  project.executeTransaction((tx) => tx.addAction(a), label);
});
const clone = (idx, off, label) => project.lockedAccess(() => {
  const ed = ppro.SequenceEditor.getEditor(seq);
  const a = ed.createCloneTrackItemAction(list()[idx], ppro.TickTime.createWithTicks(String(off)), 0, 0, false, false);
  project.executeTransaction((tx) => tx.addAction(a), label);
});
clone(i0, parkT - startT, "agent: FB6 park clone");
const ip = await findAt(Number(parkT) / 254016000000);
if (ip < 0) throw new Error("park not found");
remove(await findAt(args.startS), "agent: FB6 remove original");
clone(await findAt(Number(parkT) / 254016000000), startT - parkT, "agent: FB6 clone back");
remove(await findAt(Number(parkT) / 254016000000), "agent: FB6 remove park");
const after = await info(await findAt(args.startS));
return { before, after, same: JSON.stringify(before) === JSON.stringify(after), count: list().length };
