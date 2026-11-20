// 書き込む。名前で引いたシーケンス(args.seq)のクリップを、名前 + 開始時刻(±0.02 秒)で特定し、
// 出の変更(createSetStartAction)・消えの変更(createSetEndAction)を 1 トランザクション、
// 削除(ripple なし)を続く 1 トランザクションで行う。アイテムは lockedAccess の中で index から取り直す。
// args: {seq, dry: false, label, ops: [{op:"remove"|"setStart"|"setEnd", kind:"v"|"a", track, name, s, f?/t?}]}
//   f: 29.97 のフレーム番号(優先)、t: 秒
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const TPF = 8475667200n;
const tt = (op) => (op.f !== undefined ? ppro.TickTime.createWithTicks(String(BigInt(op.f) * TPF)) : ppro.TickTime.createWithSeconds(op.t));
const tracks = {}, meta = {};
for (const op of args.ops) {
  const k = op.kind + op.track;
  if (tracks[k]) continue;
  tracks[k] = op.kind === "v" ? await seq.getVideoTrack(op.track) : await seq.getAudioTrack(op.track);
  const items = tracks[k].getTrackItems(C.CLIP, false) || [];
  meta[k] = [];
  for (let i = 0; i < items.length; i++) meta[k].push({ i, name: await items[i].getName(), s: (await items[i].getStartTime()).seconds });
}
const resolved = [], missing = [];
for (const op of args.ops) {
  const k = op.kind + op.track;
  const hits = meta[k].filter((m) => m.name === op.name && Math.abs(m.s - op.s) < 0.02);
  if (hits.length !== 1) { missing.push({ ...op, hits: hits.length }); continue; }
  resolved.push({ op, k, i: hits[0].i });
}
if (missing.length || args.dry) return { dry: !!args.dry, resolved: resolved.length, missing };
const pick = (r) => (tracks[r.k].getTrackItems(C.CLIP, false) || [])[r.i];
const edits = resolved.filter((r) => r.op.op !== "remove");
const rm = resolved.filter((r) => r.op.op === "remove");
let err = null, rmErr = null;
if (edits.length) {
  try {
    project.lockedAccess(() => {
      const acts = edits.map((r) => (r.op.op === "setStart" ? pick(r).createSetStartAction(tt(r.op)) : pick(r).createSetEndAction(tt(r.op))));
      project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, args.label || `agent: edit ${acts.length} item(s)`);
    });
  } catch (e) { err = e?.message || String(e); }
}
if (!err && rm.length) {
  try {
    project.lockedAccess(() => {
      let sel = null;
      ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
      if (!sel) throw new Error("could not create a selection");
      for (const r of rm) sel.addItem(pick(r), true);
      const act = ppro.SequenceEditor.getEditor(seq).createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false);
      project.executeTransaction((tx) => { tx.addAction(act); }, `agent: remove ${rm.length} item(s)`);
    });
  } catch (e) { rmErr = e?.message || String(e); }
}
return { ok: !err && !rmErr, error: err, rmError: rmErr, edited: edits.length, removed: rm.length };
