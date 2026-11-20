// 書き込む。名前で引いたシーケンス(args.seq)のビデオトラック args.track に、プロジェクトアイテムを時刻順に上書き配置し、
// 置くたびに終わりを args の e に合わせる(静止画は既定の長さで入るため)。アクティブなシーケンスは使わない。
// args: {seq, track: 7, aIdx: 0, items: [{pid, s, e, sF?, eF?}]}  s/e は秒。sF/eF(29.97 のフレーム番号)があれば tick で正確に置く
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const root = await project.getRootItem();
const found = await collectClipProjectItems(root);
const res = [];
const TPF = 8475667200n; // 29.97fps 1 フレームの tick
const tt = (sec, f) => (f !== undefined ? ppro.TickTime.createWithTicks(String(BigInt(f) * TPF)) : ppro.TickTime.createWithSeconds(sec));
const sorted = [...args.items].sort((a, b) => a.s - b.s);
for (const job of sorted) {
  const hit = found.find((c) => c.id === job.pid);
  if (!hit) { res.push({ pid: job.pid, error: "no project item" }); continue; }
  let err = null;
  try {
    project.lockedAccess(() => {
      const editor = ppro.SequenceEditor.getEditor(seq);
      const act = editor.createOverwriteItemAction(ppro.ProjectItem.cast(hit.clip), tt(job.s, job.sF), args.track, args.aIdx ?? 0);
      project.executeTransaction((tx) => { tx.addAction(act); }, `agent: place ${hit.name} @${job.s.toFixed(3)}s V${args.track}`);
    });
    const t = await seq.getVideoTrack(args.track);
    const items = t.getTrackItems(C.CLIP, false) || [];
    let target = null, st = null;
    for (const it of items) {
      const s0 = (await it.getStartTime()).seconds;
      if (Math.abs(s0 - job.s) < 0.02) { target = it; st = s0; }
    }
    if (!target) throw new Error("placed item not found");
    project.lockedAccess(() => {
      const t2 = items.find((x) => x === target);
      const act = t2.createSetEndAction(tt(job.e, job.eF));
      project.executeTransaction((tx) => { tx.addAction(act); }, `agent: set end ${hit.name} ${job.e.toFixed(3)}s`);
    });
  } catch (e) { err = e?.message || String(e); }
  res.push({ name: hit.name, s: job.s, e: job.e, ok: !err, error: err });
  if (err) break;
}
const t = await seq.getVideoTrack(args.track);
const after = [];
for (const it of t.getTrackItems(C.CLIP, false) || []) after.push([await it.getName(), (await it.getStartTime()).seconds, (await it.getEndTime()).seconds]);
return { res, after };
