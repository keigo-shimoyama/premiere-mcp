// 書き込む(args.set があるとき)。シーケンス args.seq のイン・アウトを秒で設定し、guid と現在のイン・アウトを返す。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const before = { in: (await seq.getInPoint()).seconds, out: (await seq.getOutPoint()).seconds };
if (args.set) {
  project.lockedAccess(() => {
    const a = seq.createSetInPointAction(ppro.TickTime.createWithSeconds(args.inS));
    const b = seq.createSetOutPointAction(ppro.TickTime.createWithSeconds(args.outS));
    project.executeTransaction((tx) => { tx.addAction(a); tx.addAction(b); }, "agent: preview range");
  });
}
return { guid: String(seq.guid), before, now: { in: (await seq.getInPoint()).seconds, out: (await seq.getOutPoint()).seconds } };
