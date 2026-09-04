import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "sig2", version: "0.1.0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"] }));

const PI = { $projectItemId: "d8f034d7-04bc-4742-95ad-4a7686700e49" };
const CLIP = { $trackItem: { track: "V0", index: 0 } };
const T5 = { $seconds: 5 };

const shapes = {
  "8: clip,t,0,0,T,T,T,T":     [CLIP, T5, 0, 0, true, true, true, true],
  "8: clip,t,0,0,T,T,T,0":     [CLIP, T5, 0, 0, true, true, true, 0],
  "8: pItem,t,0,0,T,T,T,T":    [PI, T5, 0, 0, true, true, true, true],
  "9: clip,t,0,0,T,T,T,T,T":   [CLIP, T5, 0, 0, true, true, true, true, true],
  "8: clip,t,0,0,0,0,T,T":     [CLIP, T5, 0, 0, 0, 0, true, true],
  "clip,t,0,0,true,true":      [CLIP, T5, 0, 0, true, true],
  "clip,t,0,0,true,false":     [CLIP, T5, 0, 0, true, false],
  "pItem,t,0,0,true,true":     [PI, T5, 0, 0, true, true],
  "pItem,t,0,0,true,false":    [PI, T5, 0, 0, true, false],
  "clip,t,0,0,0,0":            [CLIP, T5, 0, 0, 0, 0],
  "clip,t,0,0,true,true,true": [CLIP, T5, 0, 0, true, true, true],
  "pItem,t,0,0,true,true,true":[PI, T5, 0, 0, true, true, true],
  "clip,t,0,0,true,true,t":    [CLIP, T5, 0, 0, true, true, T5],
  "pItem,t,0,0,0,0,0,0":       [PI, T5, 0, 0, 0, 0, 0, 0],
};

for (const method of ["createAddItemsAction"]) {
  console.log(`\n=== ${method} ===`);
  for (const [label, args] of Object.entries(shapes)) {
    const r = await c.callTool({ name: "ppro_debug_invoke",
      arguments: { target: "sequenceEditor", method, args } });
    let d; try { d = JSON.parse(r.content[0].text); } catch { d = { error: r.content[0].text }; }
    console.log(`  ${label.padEnd(30)} ${d.ok ? `OK -> ${d.resultType} ${JSON.stringify(d.resultMethods||"")}` : d.error}`);
  }
}
await c.close(); process.exit(0);
