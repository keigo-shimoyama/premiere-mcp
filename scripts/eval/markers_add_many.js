// 書き込む。アクティブなシーケンスにマーカーをまとめて足す(1 トランザクション)。同じ名前・同じ時刻のマーカーがあれば足さない。
// args: {markers: [{name, at, dur?, comments?}]}
const markers = await ppro.Markers.getMarkers(sequence);
const have = (markers.getMarkers() || []).filter(Boolean).map((m) => m.getName());
const todo = args.markers.filter((m) => !have.includes(m.name));
project.lockedAccess(() => {
  const acts = todo.map((m) => markers.createAddMarkerAction(m.name, ppro.Marker.MARKER_TYPE_COMMENT,
    ppro.TickTime.createWithSeconds(m.at), ppro.TickTime.createWithSeconds(m.dur || 0), m.comments || ""));
  project.executeTransaction((tx) => { for (const a of acts) tx.addAction(a); }, `agent: add ${acts.length} markers`);
});
const after = (await ppro.Markers.getMarkers(sequence)).getMarkers() || [];
return { added: todo.length, total: after.filter(Boolean).length };
