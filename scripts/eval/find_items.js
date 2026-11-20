// 読むだけ。プロジェクトのビンを再帰でたどり、名前に args.q(配列のどれか)を含む項目のパスと種類を返す。
const root = await project.getRootItem();
const out = [];
async function walk(folder, path, depth) {
  const kids = await folder.getItems();
  for (const k of kids || []) {
    const name = k.name;
    const p = path + "/" + name;
    const isBin = (await k.getType?.()) === ppro.Constants.ProjectItemType?.BIN || !!ppro.FolderItem.cast(k)?.getItems;
    if ((args.q || []).some((q) => name.includes(q))) {
      let media = null;
      try { media = await ppro.ClipProjectItem.cast(k).getMediaFilePath(); } catch (e) {}
      out.push({ p, media });
    }
    if (depth < 8) { try { const f = ppro.FolderItem.cast(k); if (f) await walk(f, p, depth + 1); } catch (e) {} }
  }
}
await walk(ppro.FolderItem.cast(root), "", 0);
return out.slice(0, 200);
