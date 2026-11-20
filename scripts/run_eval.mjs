// __eval を node から呼び、結果を JSON ファイルに書く(大きな結果を会話に流さないため)。
// node scripts/run_eval.mjs <script.js> <args.json|-> <out.json> [allowTraps]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const [file, argsPath, outPath, traps] = process.argv.slice(2);
const args = argsPath && argsPath !== "-" ? JSON.parse(fs.readFileSync(argsPath, "utf8")) : {};
const client = new Client({ name: "run-eval", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"], cwd: new URL("..", import.meta.url).pathname }));
const res = await client.callTool({ name: "ppro_debug_invoke", arguments: { target: "project", method: "__eval", args: [{ file, args, allowTraps: traps === "1" }] } }, undefined, { timeout: 300000 });
const text = res.content?.[0]?.text ?? "";
fs.writeFileSync(outPath, text);
await client.close();
let ok = false;
try { ok = JSON.parse(text).ok; } catch {}
console.log(res.isError ? "ERROR " + text.slice(0, 300) : ok ? "ok" : "not ok " + text.slice(0, 300));
process.exit(res.isError || !ok ? 1 : 0);
