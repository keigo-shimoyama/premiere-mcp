// node scripts/export_seq.mjs <sequenceGuid> <out.mp4> <full 1|0>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [guid, out, full] = process.argv.slice(2);
const c = new Client({ name: "exp", version: "0.1.0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"], cwd: new URL("..", import.meta.url).pathname }));
const r = await c.callTool({ name: "ppro_debug_invoke", arguments: { target: "exporter", method: "exportSequence", args: [{ $sequenceGuid: guid }, { $const: "ExportType.IMMEDIATELY" }, out, "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MediaIO/systempresets/4E49434B_48323634/01 - Match Source - High bitrate.epr", full === "1"] } }, undefined, { timeout: 3600000 });
console.log((r.content?.[0]?.text ?? "").slice(0, 400));
await c.close();
