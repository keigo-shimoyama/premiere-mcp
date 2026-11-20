// 書き込む。名前で引いたシーケンス(args.seq)から、区間 [aF, bF)(29.97 のフレーム番号)を詰めて取り除く。アクティブなシーケンスは使わない。
// api-traps §5a を守るため、既存のクリップを隣より先へ動かすことはしない(動かすのは順序を保つ左詰めだけ)。
// 後半の切れ端は「退避先の複製 → 区間の詰め → 空いた所へもう一度複製(新しいアイテム)→ 退避先を消す」で作る(cloneAt と同じ考え方)。
// - 本編トラック(args.interview: {v:[...], a:[...]}): 区間をまたぐクリップは前後に分ける。
// - その他のトラック(テロップ・インサート・扉・BGM など): またぐものは尻を d だけ縮め、区間に頭が入るものは頭を b に詰め、区間に収まるものは消す。
// args: {seq, aF, bF, interview:{v:[0,1,2,3], a:[0,1,2]}, dry:false}
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const TPF = 8475667200n;
const T = (ticks) => ppro.TickTime.createWithTicks(String(ticks));
const aT = BigInt(args.aF) * TPF, bT = BigInt(args.bF) * TPF, dT = bT - aT;
if (dT <= 0n) throw new Error("bF must be greater than aF");
const tk = async (p) => BigInt(String((await p).ticks));

const tracks = [];
const vc = await seq.getVideoTrackCount(), ac = await seq.getAudioTrackCount();
for (let i = 0; i < vc; i++) tracks.push({ id: "V" + i, t: await seq.getVideoTrack(i), inter: (args.interview.v || []).includes(i) });
for (let i = 0; i < ac; i++) tracks.push({ id: "A" + i, t: await seq.getAudioTrack(i), inter: (args.interview.a || []).includes(i) });

async function read(tr) {
  const items = tr.t.getTrackItems(C.CLIP, false) || [];
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) continue;
    rows.push({ i, name: await items[i].getName(), s: await tk(items[i].getStartTime()), e: await tk(items[i].getEndTime()) });
  }
  return rows;
}
const commit = (tr, pairs, label) => {
  if (!pairs.length) return;
  project.lockedAccess(() => {
    const editor = ppro.SequenceEditor.getEditor(seq);
    const items = tr.t.getTrackItems(C.CLIP, false) || [];
    const acts = pairs.map(([i, make]) => make(items[i], editor));
    project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, label);
  });
};
const removeRows = (tr, idxs, label) => {
  if (!idxs.length) return;
  project.lockedAccess(() => {
    const items = tr.t.getTrackItems(C.CLIP, false) || [];
    let sel = null;
    ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
    for (const i of idxs) sel.addItem(items[i], true);
    const act = ppro.SequenceEditor.getEditor(seq).createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false);
    project.executeTransaction((tx) => { tx.addAction(act); }, label);
  });
};

// 計画
const plan = [];
let tEnd = 0n;
for (const tr of tracks) {
  tr.rows = await read(tr);
  for (const r of tr.rows) if (r.e > tEnd) tEnd = r.e;
}
const FT = (tEnd / TPF + 600n) * TPF; // 退避先(終わりより 20 秒ほど後ろ、フレーム境界)
for (const tr of tracks) {
  tr.plan = { span: [], rm: [], end: [], start: [], shrink: [] };
  for (const r of tr.rows) {
    if (!(r.s < bT && r.e > aT)) continue;
    if (r.s < aT && r.e > bT) (tr.inter ? tr.plan.span : tr.plan.shrink).push(r);
    else if (r.s >= aT && r.e <= bT) tr.plan.rm.push(r);
    else if (r.s < aT) tr.plan.end.push(r);
    else tr.plan.start.push(r);
  }
  const p = tr.plan;
  if (p.span.length + p.rm.length + p.end.length + p.start.length + p.shrink.length)
    plan.push({ id: tr.id, span: p.span.map((r) => r.name), rm: p.rm.map((r) => r.name), end: p.end.map((r) => r.name), start: p.start.map((r) => r.name), shrink: p.shrink.map((r) => r.name) });
}
if (args.dry) return { dry: true, plan, FTsec: Number(FT) / 254016000000 };

const label = `agent: cut ${args.aF}-${args.bF}`;
// 1. 本編のまたぎを退避先へ複製
for (const tr of tracks) {
  if (!tr.plan.span.length) continue;
  const off = T(FT);
  commit(tr, tr.plan.span.map((r) => [r.i, (it, ed) => ed.createCloneTrackItemAction(it, off, 0, 0, true, false)]), label + " park " + tr.id);
}
for (const tr of tracks) {
  if (!tr.plan.span.length) { tr.parked = []; continue; }
  const parked = (await read(tr)).filter((r) => r.s >= FT);
  tr.parked = parked;
  if (parked.length !== tr.plan.span.length) {
    // リンクで余計に複製された等。退避先を片付けて止める(本体はまだ触っていない)
    for (const t2 of tracks.filter((x) => x.plan.span.length)) {
      const pk = (await read(t2)).filter((r) => r.s >= FT);
      removeRows(t2, pk.map((r) => r.i), label + " abort " + t2.id);
    }
    throw new Error(`clone mismatch on ${tr.id}: parked ${parked.length} vs span ${tr.plan.span.length} (parked clones removed)`);
  }
}
// 2. 縮め・詰め(1 トラック 1 トランザクション)
for (const tr of tracks) {
  const p = tr.plan, pairs = [];
  for (const r of p.span) pairs.push([r.i, (it) => it.createSetEndAction(T(aT))]);
  for (const r of p.end) pairs.push([r.i, (it) => it.createSetEndAction(T(aT))]);
  for (const r of p.start) pairs.push([r.i, (it) => it.createSetStartAction(T(bT))]);
  for (const r of p.shrink) pairs.push([r.i, (it) => it.createSetEndAction(T(r.e - dT))]);
  for (const r of tr.parked) pairs.push([r.i, (it) => it.createSetStartAction(T(bT + FT))]);
  commit(tr, pairs, label + " trim " + tr.id);
}
// 3. 区間に収まるものを消す(読み直してから時刻で選ぶ)
for (const tr of tracks) {
  if (!tr.plan.rm.length) continue;
  const rows = (await read(tr)).filter((r) => r.s >= aT && r.e <= bT);
  removeRows(tr, rows.map((r) => r.i), label + " remove " + tr.id);
}
// 4. b 以降(退避先を除く)を d だけ前へ。順序を保つ左詰め
const moved = {};
for (const tr of tracks) {
  if (!tr.rows.some((r) => r.e > aT)) { moved[tr.id] = 0; continue; }
  const rows = (await read(tr)).filter((r) => r.s >= bT && r.s < FT).sort((x, y) => (x.s < y.s ? -1 : 1));
  moved[tr.id] = rows.length;
  commit(tr, rows.map((r) => [r.i, (it) => it.createMoveAction(T(-dT))]), label + " shift " + tr.id);
}
// 5. 退避した後半を、空いた [a, e-d] へ新しく複製する(既存アイテムは動かさない)
const back = T(-(FT + dT));
for (const tr of tracks.filter((x) => x.plan.span.length)) {
  const parked = (await read(tr)).filter((r) => r.s >= FT);
  commit(tr, parked.map((r) => [r.i, (it, ed) => ed.createCloneTrackItemAction(it, back, 0, 0, true, false)]), label + " place " + tr.id);
}
// 6. 退避先を消す
for (const tr of tracks.filter((x) => x.plan.span.length)) {
  const parked = (await read(tr)).filter((r) => r.s >= FT);
  removeRows(tr, parked.map((r) => r.i), label + " unpark " + tr.id);
}
// 確認: 重なり・退避先の残り・a に頭がある本編の数
const check = {};
for (const tr of (args.check ? tracks : [])) {
  const rows = (await read(tr)).sort((x, y) => (x.s < y.s ? -1 : 1));
  const over = [];
  for (let k = 1; k < rows.length; k++) if (rows[k].s < rows[k - 1].e) over.push([rows[k - 1].name, rows[k].name, Number(rows[k].s) / 254016000000]);
  check[tr.id] = { n: rows.length, over: over.slice(0, 5), parked: rows.filter((r) => r.s >= FT).length, headAtA: rows.filter((r) => r.s === aT).length };
}
return { ok: true, plan, moved, check };
