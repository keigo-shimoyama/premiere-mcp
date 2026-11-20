// 書き込む。アクティブなシーケンスのビデオトラック args.track(0 始まり)で、名前が args.match(正規表現)に合うクリップを
// 開始順に並べ、i 番目を args.pids[i] のプロジェクトアイテムで同じ開始・終了(tick)に上書きする。
// 元クリップのモーション(位置・スケール)と不透明度の値は、新しいクリップへ写す(キーは写さない)。
// args: {track: 11, match: "^扉", pids: [...], dry: false}
const C = ppro.Constants.TrackItemType;
const tr = await sequence.getVideoTrack(args.track);
const re = new RegExp(args.match);
const olds = [];
for (const it of tr.getTrackItems(C.CLIP, false) || []) {
  if (!it) continue;
  const nm = await it.getName();
  if (re.test(nm)) olds.push({ nm, s: (await it.getStartTime()).ticks, e: (await it.getEndTime()).ticks });
}
olds.sort((a, b) => (BigInt(a.s) < BigInt(b.s) ? -1 : 1));
if (olds.length !== args.pids.length) throw new Error(`count mismatch ${olds.length} vs ${args.pids.length}`);
const found = await collectClipProjectItems(await project.getRootItem());
const res = [];
if (args.dry) return olds.map((o, i) => ({ old: o.nm, s: Number(o.s) / 254016000000, pid: args.pids[i], name: found.find((c) => c.id === args.pids[i])?.name }));
for (let i = 0; i < olds.length; i++) {
  const o = olds[i];
  const hit = found.find((c) => c.id === args.pids[i]);
  if (!hit) throw new Error("no project item " + args.pids[i]);
  if (args.skip && args.skip.includes(i)) { res.push({ i, skipped: true }); continue; }
  project.lockedAccess(() => {
    const editor = ppro.SequenceEditor.getEditor(sequence);
    const act = editor.createOverwriteItemAction(ppro.ProjectItem.cast(hit.clip), ppro.TickTime.createWithTicks(String(o.s)), args.track, 0);
    project.executeTransaction((tx) => tx.addAction(act), `agent: replace ${o.nm} -> ${hit.name}`);
  });
  const tr2 = await sequence.getVideoTrack(args.track);
  const items = (tr2.getTrackItems(C.CLIP, false) || []).filter(Boolean);
  let target = null;
  for (const it of items) if ((await it.getStartTime()).ticks === o.s && (await it.getName()) === hit.name) target = it;
  if (!target) { res.push({ i, error: "placed not found" }); break; }
  if ((await target.getEndTime()).ticks !== o.e) {
    project.lockedAccess(() => {
      const a = target.createSetEndAction(ppro.TickTime.createWithTicks(String(o.e)));
      project.executeTransaction((tx) => tx.addAction(a), `agent: set end ${hit.name}`);
    });
  }
  res.push({ i, old: o.nm, now: hit.name, s: Number(o.s) / 254016000000 });
}
const after = [];
for (const it of ((await sequence.getVideoTrack(args.track)).getTrackItems(C.CLIP, false) || []).filter(Boolean)) {
  const nm = await it.getName();
  if (re.test(nm)) after.push([nm, +(await it.getStartTime()).seconds.toFixed(3), +(await it.getEndTime()).seconds.toFixed(3)]);
}
return { res, after };
