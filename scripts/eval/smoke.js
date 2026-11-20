// __eval の動作確認(読むだけ)。シーケンスの数とアクティブなシーケンス名を返す。
// 呼び方: ppro_debug_invoke {target:"project", method:"__eval", args:[{file:"<このファイルの絶対パス>"}]}
const seqs = await project.getSequences();
log("sequences", seqs.length);
return { project: project.name, active: sequence ? sequence.name : null, sequences: seqs.length, args };
