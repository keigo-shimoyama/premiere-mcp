// 書き込む。アクティブなシーケンスのビデオトラック args.track(0 始まり)で、名前が args.name・開始が args.s(±0.02 秒)のクリップを、
// プロジェクトアイテム args.pid(静止画)で同じ開始・終了に上書きする。静止画の既定尺で後ろを潰さないよう、
// 先にプロジェクトアイテムのイン・アウトを [0, 尺] にしてから上書きする。前後のクリップが変わっていないかを返す。
// args: {ops: [{track, name, s, pid}], dry}
const C = ppro.Constants.TrackItemType;
const found = await collectClipProjectItems(await project.getRootItem());
const items = async (t) => (((await sequence.getVideoTrack(t)).getTrackItems(C.CLIP, false)) || []).filter(Boolean);
const snap = async (t) => { const r = []; for (const it of await items(t)) r.push([(await it.getName()), (await it.getStartTime()).ticks, (await it.getEndTime()).ticks]); return r; };
const res = [];
for (const op of args.ops) {
  let target = null;
  for (const it of await items(op.track)) if (Math.abs((await it.getStartTime()).seconds - op.s) < 0.02 && (await it.getName()) === op.name) target = it;
  if (!target) { res.push({ op, error: "target not found" }); continue; }
  const s = (await target.getStartTime()).ticks, e = (await target.getEndTime()).ticks;
  const hit = found.find((c) => c.id === op.pid);
  if (!hit) { res.push({ op, error: "pid not found" }); continue; }
  if (args.dry) { res.push({ op, s: Number(s) / 254016000000, e: Number(e) / 254016000000, now: hit.name }); continue; }
  const before = await snap(op.track);
  const cp = ppro.ClipProjectItem.cast(hit.clip);
  const dur = BigInt(e) - BigInt(s);
  project.lockedAccess(() => {
    const a = cp.createSetInOutPointsAction(ppro.TickTime.createWithTicks("0"), ppro.TickTime.createWithTicks(String(dur)));
    project.executeTransaction((tx) => tx.addAction(a), `agent: set in/out ${hit.name}`);
  });
  project.lockedAccess(() => {
    const ed = ppro.SequenceEditor.getEditor(sequence);
    const a = ed.createOverwriteItemAction(ppro.ProjectItem.cast(hit.clip), ppro.TickTime.createWithTicks(String(s)), op.track, 0);
    project.executeTransaction((tx) => tx.addAction(a), `agent: overwrite ${op.name} -> ${hit.name}`);
  });
  let placed = null;
  for (const it of await items(op.track)) if ((await it.getStartTime()).ticks === s) placed = it;
  if (placed && (await placed.getEndTime()).ticks !== e) {
    project.lockedAccess(() => {
      const a = placed.createSetEndAction(ppro.TickTime.createWithTicks(String(e)));
      project.executeTransaction((tx) => tx.addAction(a), `agent: set end ${hit.name}`);
    });
  }
  const after = await snap(op.track);
  const changed = after.filter((r) => !before.some((b) => b[0] === r[0] && b[1] === r[1] && b[2] === r[2])).map((r) => [r[0], Number(r[1]) / 254016000000, Number(r[2]) / 254016000000]);
  res.push({ name: op.name, s: Number(s) / 254016000000, countBefore: before.length, countAfter: after.length, changed });
}
return res;
