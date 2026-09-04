/**
 * Runs every read-only probe against the live panel and writes full output to
 * out/ for inspection. Prints a short summary.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("out", { recursive: true });
const client = new Client({ name: "probe-runner", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"] }));

const calls = [
  ["ppro_echo", { message: "hello premiere" }],
  ["ppro_env", {}],
  ["ppro_timeline_dump", {}],
  ["ppro_selection", {}],
  ["ppro_transcript_probe", { headBytes: 200000 }],
];

for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  await writeFile(`out/${name}.json`, text);
  console.log(`\n${"=".repeat(70)}\n${name}${res.isError ? "  [ERROR]" : ""}\n${"=".repeat(70)}`);
  console.log(text.length > 4000 ? text.slice(0, 4000) + `\n... (${text.length} bytes total, full copy in out/${name}.json)` : text);
}

await client.close();
process.exit(0);
