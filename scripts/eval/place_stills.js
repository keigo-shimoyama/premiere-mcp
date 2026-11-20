// 書き込む。アクティブなシーケンスのビデオトラック op.track(0 始まり)の空いている [s, e](tick 文字列)に、
// 静止画のプロジェクトアイテム op.pid を置く。範囲に何かあれば置かずに報告する。args.dry なら判定だけ返す。
// 静止画の既定尺で後ろを潰さないよう、先にプロジェクトアイテムのイン・アウトを [0, 尺] にしてから上書きする。
// args: {dry, ops: [{track, pid, s, e, label}]}
const C = ppro.Constants.TrackItemType;
const TPS = 254016000000;
const found = await collectClipProjectItems(await project.getRootItem());
const items = async (t) => (((await sequence.getVideoTrack(t)).getTrackItems(C.CLIP, false)) || []).filter(Boolean);
const res = [];
for (const op of args.ops) {
  const s = BigInt(op.s), e = BigInt(op.e);
  const block = [];
  for (const it of await items(op.track)) {
    const a = BigInt((await it.getStartTime()).ticks), b = BigInt((await it.getEndTime()).ticks);
    if (a < e && b > s) block.push([await it.getName(), Number(a) / TPS, Number(b) / TPS]);
  }
  const hit = found.find((c) => c.id === op.pid);
  const row = { label: op.label, s: Number(s) / TPS, e: Number(e) / TPS, name: hit && hit.name, block };
  if (!hit) { row.error = "pid not found"; res.push(row); continue; }
  if (block.length || args.dry) { res.push(row); continue; }
  const cp = ppro.ClipProjectItem.cast(hit.clip);
  project.lockedAccess(() => {
    const a = cp.createSetInOutPointsAction(ppro.TickTime.createWithTicks("0"), ppro.TickTime.createWithTicks(String(e - s)));
    project.executeTransaction((tx) => tx.addAction(a), `agent: set in/out ${hit.name}`);
  });
  project.lockedAccess(() => {
    const ed = ppro.SequenceEditor.getEditor(sequence);
    const a = ed.createOverwriteItemAction(ppro.ProjectItem.cast(hit.clip), ppro.TickTime.createWithTicks(String(s)), op.track, 0);
    project.executeTransaction((tx) => tx.addAction(a), `agent: place ${op.label}`);
  });
  let placed = null;
  for (const it of await items(op.track)) if (BigInt((await it.getStartTime()).ticks) === s) placed = it;
  if (!placed) { row.error = "placed not found"; res.push(row); break; }
  if (BigInt((await placed.getEndTime()).ticks) !== e) {
    project.lockedAccess(() => {
      const a = placed.createSetEndAction(ppro.TickTime.createWithTicks(String(e)));
      project.executeTransaction((tx) => tx.addAction(a), `agent: set end ${op.label}`);
    });
  }
  row.now = [await placed.getName(), Number((await placed.getStartTime()).ticks) / TPS, Number((await placed.getEndTime()).ticks) / TPS];
  res.push(row);
}
return res;
