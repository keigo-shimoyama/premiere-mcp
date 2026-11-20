// 書き込む。args.parent(bin のパス。"/" 区切り、root 起点)の下に args.bin を作り(あれば再利用)、
// args.paths を suppressUI で読み込む。読み込み後の bin の中身(再帰)を返す。
// args: {parent: "テロップ・コピー_PSD", bin: "③横10分_字幕_v5", paths: ["/abs/a.psd", ...]}
const root = await project.getRootItem();
let binRawId = null;
async function child(folder, name) {
  for (const it of await folder.getItems()) if (it.name === name && ppro.FolderItem.cast(it)) { binRawId = it.getId(); return ppro.FolderItem.cast(it); }
  return null;
}
let parent = root;
for (const seg of (args.parent || "").split("/").filter(Boolean)) {
  parent = await child(parent, seg);
  if (!parent) throw new Error("parent bin not found: " + seg);
}
let bin = await child(parent, args.bin);
if (!bin) {
  project.lockedAccess(() => {
    const act = parent.createBinAction(args.bin, true);
    project.executeTransaction((tx) => { tx.addAction(act); }, `agent: mkbin ${args.bin}`);
  });
  bin = await child(parent, args.bin);
}
if (!bin) throw new Error("could not create bin");
let ok = null;
if ((args.paths || []).length) ok = await project.importFiles(args.paths, true, bin, false);
const out = [];
async function walk(f, p) {
  for (const it of await f.getItems()) {
    const af = ppro.FolderItem.cast(it);
    if (af) { await walk(af, p + "/" + it.name); continue; }
    let media = null;
    try { media = await ppro.ClipProjectItem.cast(it).getMediaFilePath(); } catch (e) {}
    out.push({ id: it.getId(), p: p + "/" + it.name, media });
  }
}
await walk(bin, "");
return { imported: ok, binId: binRawId, items: out };
