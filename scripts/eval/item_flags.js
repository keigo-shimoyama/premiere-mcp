// 読む。シーケンス args.seq の args.from〜args.to 秒の、全オーディオ/ビデオトラックのクリップの無効・速度・トラックのミュート。
const seq = (await project.getSequences()).find((s) => s.name === args.seq);
const C = ppro.Constants.TrackItemType;
const out = [];
for (const kind of ["A", "V"]) {
  const n = kind === "A" ? await seq.getAudioTrackCount() : await seq.getVideoTrackCount();
  for (let ti = 0; ti < n; ti++) {
    const t = kind === "A" ? await seq.getAudioTrack(ti) : await seq.getVideoTrack(ti);
    let muted = null; try { muted = await t.isMuted(); } catch (e) {}
    const items = t.getTrackItems(C.CLIP, false) || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const s = (await it.getStartTime()).seconds, e = (await it.getEndTime()).seconds;
      if (e <= args.from || s >= args.to) continue;
      let dis = null, sp = null; try { dis = await it.isDisabled(); } catch (x) {}
      try { sp = await it.getSpeed(); } catch (x) {}
      out.push([kind + ti, muted, i, await it.getName(), Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000, dis, sp]);
    }
  }
}
return out;
