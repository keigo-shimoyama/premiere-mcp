// 書き込む。シーケンス args.seq のビデオトラック args.v で、開始フレーム args.startF(29.97)のクリップの無効フラグを args.disabled にする。
const TPF = 8475667200n;
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const vt = await seq.getVideoTrack(args.v);
const C = ppro.Constants.TrackItemType;
const items = vt.getTrackItems(C.CLIP, false) || [];
let idx = -1;
for (let i = 0; i < items.length; i++) if (Number(BigInt((await items[i].getStartTime()).ticks) / TPF) === args.startF) idx = i;
if (idx < 0) throw new Error("not found");
project.lockedAccess(() => {
  const it = (vt.getTrackItems(C.CLIP, false) || [])[idx];
  const a = it.createSetDisabledAction(!!args.disabled);
  project.executeTransaction((tx) => tx.addAction(a), `agent: set disabled ${args.disabled}`);
});
return { idx, disabled: await (vt.getTrackItems(C.CLIP, false) || [])[idx].isDisabled() };
