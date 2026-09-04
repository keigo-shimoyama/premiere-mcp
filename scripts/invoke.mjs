/** Ad-hoc reflective call: node scripts/invoke.mjs <target> <method> '<jsonArgsArray>' */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [target, method, argsJson] = process.argv.slice(2);
const c = new Client({ name: "invoke", version: "0.1.0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"] }));
const r = await c.callTool({
  name: "ppro_debug_invoke",
  arguments: { target, method, args: argsJson ? JSON.parse(argsJson) : [] },
});
console.log(r.content[0].text);
await c.close();
process.exit(0);
