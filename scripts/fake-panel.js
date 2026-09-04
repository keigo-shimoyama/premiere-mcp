/**
 * Stand-in for the UXP panel, for exercising the proxy and MCP server without
 * launching Premiere. Answers the same command names with canned data.
 */
import WebSocket from "ws";

const URL = process.env.PPRO_PROXY_URL || "ws://127.0.0.1:3001";
const ws = new WebSocket(URL);

const commands = {
  echo: (p) => ({ message: p.message ?? null, app: "premierepro", version: "26.3.2-fake" }),
  env: () => ({ appVersion: "26.3.2-fake", project: null, sequence: null, features: {} }),
  "timeline.dump": () => ({ tracks: [], note: "fake panel" }),
  "selection.get": () => ({ count: 0, items: [] }),
  "transcript.probe": () => ({ clipsScanned: 0, transcript: null, note: "fake panel" }),
};

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "register", role: "panel", app: "premierepro" }));
  console.error("[fake-panel] registered");
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== "command") return;
  const fn = commands[msg.command];
  const response = fn
    ? { type: "response", id: msg.id, ok: true, result: fn(msg.params || {}) }
    : { type: "response", id: msg.id, ok: false, error: `unknown command: ${msg.command}` };
  console.error(`[fake-panel] ${msg.command} -> ok=${response.ok}`);
  ws.send(JSON.stringify(response));
});
