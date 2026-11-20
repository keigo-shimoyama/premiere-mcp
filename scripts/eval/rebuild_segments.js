// 書き込む。名前で引いたシーケンス(args.seq)を、旧タイムラインの区間リスト(args.segs、29.97 のフレーム番号、新しい順)で組み直す。
// 既存アイテムは一切動かさない(api-traps §5a)。流れ:
//   A. 各ピースの元クリップを、トラックごとに重ならない退避スロットへ複製(1 tx)
//   B. 退避した複製の尻と頭をピースの範囲に切り詰め(2 tx。頭は延長もあり)
//   C. 対象トラックの元アイテムを全部消す(リップルなし、1 tx)
//   D. 切り詰めた退避ピースを、空いた最終位置へもう一度複製(1 tx)
//   E. 退避先を消す(1 tx)。F. 全長トラック(args.fullLen)の尻を新しい尺に、args.disable を無効に(1 tx)
// args: {seq, segs:[{n,a,b,N, skipTracks?, skipEarly?, skipEarlyAll?, extendHead?}], bgm:[{src,N,len}], exclude:[..], fullLen:[..], disable:[..], total, dry}
//   bgm は A3 を章ごとに 1 本ずつ置き直す(src=元クリップの頭フレーム、len=新しい章の長さ。元より長ければ尻を延ばす)
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
if (!seq) throw new Error("sequence not found: " + args.seq);
const C = ppro.Constants.TrackItemType;
const TPF = 8475667200n;
const T = (ticks) => ppro.TickTime.createWithTicks(String(ticks));
const tk = async (p) => BigInt(String((await p).ticks));
const sec = (t) => Number(t) / 254016000000;
const BGM_TRACK = "A3";

const tracks = [];
const vc = await seq.getVideoTrackCount(), ac = await seq.getAudioTrackCount();
for (let i = 0; i < vc; i++) tracks.push({ id: "V" + i, t: await seq.getVideoTrack(i) });
for (let i = 0; i < ac; i++) tracks.push({ id: "A" + i, t: await seq.getAudioTrack(i) });
const byId = Object.fromEntries(tracks.map((x) => [x.id, x]));

async function read(tr) {
  const items = tr.t.getTrackItems(C.CLIP, false) || [];
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) continue;
    rows.push({ i, name: await items[i].getName(), s: await tk(items[i].getStartTime()), e: await tk(items[i].getEndTime()) });
  }
  return rows;
}
// trackId -> [[rowIndex, (item, editor) => action]] を 1 トランザクションで
const commitMulti = (perTrack, label) => {
  const ids = Object.keys(perTrack).filter((k) => perTrack[k].length);
  if (!ids.length) return 0;
  let n = 0;
  project.lockedAccess(() => {
    const editor = ppro.SequenceEditor.getEditor(seq);
    const acts = [];
    for (const id of ids) {
      const items = byId[id].t.getTrackItems(C.CLIP, false) || [];
      for (const [i, make] of perTrack[id]) acts.push(make(items[i], editor));
    }
    n = acts.length;
    project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, label);
  });
  return n;
};
const removeMulti = (perTrack, label) => {
  const ids = Object.keys(perTrack).filter((k) => perTrack[k].length);
  if (!ids.length) return 0;
  let n = 0;
  project.lockedAccess(() => {
    let sel = null;
    ppro.TrackItemSelection.createEmptySelection((s) => { sel = s; });
    for (const id of ids) {
      const items = byId[id].t.getTrackItems(C.CLIP, false) || [];
      for (const i of perTrack[id]) { sel.addItem(items[i], true); n++; }
    }
    const act = ppro.SequenceEditor.getEditor(seq).createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false);
    project.executeTransaction((tx) => { tx.addAction(act); }, label);
  });
  return n;
};

// ---- 計画 ----
let tEnd = 0n;
const offGrid = [];
for (const tr of tracks) {
  tr.rows = await read(tr);
  for (const r of tr.rows) {
    if (r.e > tEnd) tEnd = r.e;
    if (r.s % TPF !== 0n || r.e % TPF !== 0n) offGrid.push([tr.id, r.name, sec(r.s), sec(r.e)]);
  }
}
const P = (tEnd / TPF + 1800n) * TPF; // 退避先の起点(終わりから 60 秒ほど後ろ)
const excl = new Set(args.exclude || []);
const pieces = []; // {tr, row, ps, pe, fs}
for (const sg of args.segs) {
  const a = BigInt(sg.a) * TPF, b = BigInt(sg.b) * TPF, N = BigInt(sg.N) * TPF;
  for (const tr of tracks) {
    if (excl.has(tr.id) || (sg.skipTracks || []).includes(tr.id)) continue;
    const ext = (sg.extendHead || []).includes(tr.id);
    const covered = tr.rows.some((r) => r.s <= a && r.e > a);
    let firstLater = null;
    for (const r of tr.rows) {
      if (!(r.s < b && r.e > a)) continue;
      if (r.s < a && (sg.skipEarlyAll || (sg.skipEarly || []).includes(tr.id))) continue;
      let ps = r.s > a ? r.s : a, pe = r.e < b ? r.e : b;
      if (ext && !covered && r.s > a && (firstLater === null || r.s < firstLater.s)) firstLater = r;
      pieces.push({ tr: tr.id, row: r, ps, pe, seg: sg.n, a, N });
    }
    if (firstLater) {
      const pc = pieces.find((p) => p.tr === tr.id && p.row === firstLater && p.seg === sg.n);
      pc.ps = a; pc.extended = sec(firstLater.s - a);
    }
  }
}
for (const p of pieces) { p.fs = p.N + (p.ps - p.a); p.fe = p.N + (p.pe - p.a); }
// BGM
const bgmTr = byId[BGM_TRACK];
for (const bg of args.bgm || []) {
  const src = BigInt(bg.src) * TPF, len = BigInt(bg.len) * TPF, N = BigInt(bg.N) * TPF;
  const r = bgmTr.rows.find((x) => x.s === src);
  if (!r) throw new Error("bgm source not found at frame " + bg.src);
  pieces.push({ tr: BGM_TRACK, row: r, ps: r.s, pe: r.s + len, fs: N, fe: N + len, seg: "BGM" });
}
// 退避スロット
const cursor = {};
for (const p of pieces) {
  let c = cursor[p.tr] ?? P;
  const lead = p.row.s > p.ps ? p.row.s - p.ps : 0n;
  p.slot = c + lead;
  const tailEnd = p.pe > p.row.e ? p.pe : p.row.e;
  cursor[p.tr] = p.slot + (tailEnd - p.row.s) + 300n * TPF;
}
// 最終位置の重なり検査
const overlaps = [];
const perTr = {};
for (const p of pieces) (perTr[p.tr] = perTr[p.tr] || []).push(p);
for (const id in perTr) {
  const arr = perTr[id].slice().sort((x, y) => (x.fs < y.fs ? -1 : 1));
  for (let k = 1; k < arr.length; k++) if (arr[k].fs < arr[k - 1].fe) overlaps.push([id, arr[k - 1].row.name, arr[k].row.name, sec(arr[k].fs)]);
}
const summary = Object.fromEntries(Object.entries(perTr).map(([k, v]) => [k, v.length]));
const extended = pieces.filter((p) => p.extended).map((p) => [p.tr, p.row.name, p.extended]);
if (args.dry || overlaps.length) {
  return { dry: !!args.dry, pieces: pieces.length, summary, overlaps: overlaps.slice(0, 20), offGrid: offGrid.slice(0, 20), extended, Psec: sec(P), totalSec: args.total * 1001 / 30000 };
}

const label = "agent: rebuild koba";
const L = {};
// A. 退避スロットへ複製
const A = {};
for (const p of pieces) (A[p.tr] = A[p.tr] || []).push([p.row.i, (it, ed) => ed.createCloneTrackItemAction(it, T(p.slot - p.row.s), 0, 0, true, false)]);
L.clone = commitMulti(A, label + " park");
// 読み直して退避スロットと突き合わせ
const mismatch = [];
for (const tr of tracks) {
  const mine = pieces.filter((p) => p.tr === tr.id);
  const parked = (await read(tr)).filter((r) => r.s >= P);
  if (parked.length !== mine.length) mismatch.push([tr.id, parked.length, mine.length]);
  for (const p of mine) {
    const r = parked.find((x) => x.s === p.slot);
    if (!r) mismatch.push([tr.id, "noSlot", p.row.name, sec(p.slot)]);
  }
}
if (mismatch.length) {
  const rm = {};
  for (const tr of tracks) rm[tr.id] = (await read(tr)).filter((r) => r.s >= P).map((r) => r.i);
  removeMulti(rm, label + " abort");
  throw new Error("park mismatch (parked removed): " + JSON.stringify(mismatch.slice(0, 10)));
}
// B1. 尻
const B1 = {};
for (const tr of tracks) {
  const parked = (await read(tr)).filter((r) => r.s >= P);
  for (const p of pieces.filter((q) => q.tr === tr.id)) {
    const r = parked.find((x) => x.s === p.slot);
    const want = p.slot + (p.pe - p.row.s);
    if (r.e !== want) (B1[tr.id] = B1[tr.id] || []).push([r.i, (it) => it.createSetEndAction(T(want))]);
  }
}
L.setEnd = commitMulti(B1, label + " trim end");
// B2. 頭
const B2 = {};
for (const tr of tracks) {
  const parked = (await read(tr)).filter((r) => r.s >= P);
  for (const p of pieces.filter((q) => q.tr === tr.id)) {
    const r = parked.find((x) => x.s === p.slot);
    const want = p.slot + (p.ps - p.row.s);
    if (want !== p.slot) (B2[tr.id] = B2[tr.id] || []).push([r.i, (it) => it.createSetStartAction(T(want))]);
  }
}
L.setStart = commitMulti(B2, label + " trim start");
// 切り詰めの検証
const bad = [];
for (const tr of tracks) {
  const parked = (await read(tr)).filter((r) => r.s >= P);
  for (const p of pieces.filter((q) => q.tr === tr.id)) {
    const s = p.slot + (p.ps - p.row.s), e = p.slot + (p.pe - p.row.s);
    if (!parked.find((x) => x.s === s && x.e === e)) bad.push([tr.id, p.row.name, sec(s), sec(e)]);
  }
}
if (bad.length) throw new Error("trim verify failed (originals untouched, parked left in place): " + JSON.stringify(bad.slice(0, 10)));
// C. 元を消す
const Cr = {};
for (const tr of tracks) {
  if (excl.has(tr.id) && tr.id !== BGM_TRACK) continue;
  Cr[tr.id] = (await read(tr)).filter((r) => r.s < P).map((r) => r.i);
}
L.removed = removeMulti(Cr, label + " remove originals");
// D. 最終位置へ複製
const D = {};
for (const tr of tracks) {
  const parked = (await read(tr)).filter((r) => r.s >= P);
  for (const p of pieces.filter((q) => q.tr === tr.id)) {
    const s = p.slot + (p.ps - p.row.s);
    const r = parked.find((x) => x.s === s);
    (D[tr.id] = D[tr.id] || []).push([r.i, (it, ed) => ed.createCloneTrackItemAction(it, T(p.fs - s), 0, 0, true, false)]);
  }
}
L.placed = commitMulti(D, label + " place");
// 配置の検証
const miss = [];
for (const tr of tracks) {
  const rows = (await read(tr)).filter((r) => r.s < P);
  for (const p of pieces.filter((q) => q.tr === tr.id)) if (!rows.find((x) => x.s === p.fs && x.e === p.fe)) miss.push([tr.id, p.row.name, sec(p.fs)]);
}
// E. 退避先を消す(配置に欠けがあれば残す)
if (!miss.length) {
  const E = {};
  for (const tr of tracks) E[tr.id] = (await read(tr)).filter((r) => r.s >= P).map((r) => r.i);
  L.unparked = removeMulti(E, label + " unpark");
}
// F. 全長トラックと無効化
const total = BigInt(args.total) * TPF;
const Fx = {};
for (const id of args.fullLen || []) {
  const rows = await read(byId[id]);
  for (const r of rows) if (r.e > total) (Fx[id] = Fx[id] || []).push([r.i, (it) => it.createSetEndAction(T(total))]);
}
L.fullLen = commitMulti(Fx, label + " full length");
const Dx = {};
for (const id of args.disable || []) {
  const rows = await read(byId[id]);
  Dx[id] = rows.map((r) => [r.i, (it) => it.createSetDisabledAction(true)]);
}
L.disabled = commitMulti(Dx, label + " disable");
// 検査
const check = {};
for (const tr of tracks) {
  const rows = (await read(tr)).sort((x, y) => (x.s < y.s ? -1 : 1));
  const over = [];
  for (let k = 1; k < rows.length; k++) if (rows[k].s < rows[k - 1].e) over.push([rows[k - 1].name, rows[k].name, sec(rows[k].s)]);
  check[tr.id] = { n: rows.length, end: rows.length ? sec(rows[rows.length - 1].e) : 0, over: over.slice(0, 3), parked: rows.filter((r) => r.s >= P).length };
}
return { ok: !miss.length, log: L, miss: miss.slice(0, 20), extended, check, seqEnd: (await seq.getEndTime()).seconds };
