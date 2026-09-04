/**
 * WebSocket proxy between MCP servers and the UXP panel inside Premiere.
 *
 * The panel cannot listen (there is no Node inside UXP), so it dials in here
 * as a client and this process brokers between it and any number of MCP
 * clients. One panel per app; last registration wins.
 *
 *   client --{command}--> proxy --> panel --> premierepro API
 *   client <--{response}-- proxy <-- panel
 */
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PPRO_PROXY_PORT || 3001);
const HOST = process.env.PPRO_PROXY_HOST || "127.0.0.1";
// Commands the panel has not answered within this window are failed, so a
// stalled panel surfaces as an error instead of a hung MCP tool call.
const COMMAND_TIMEOUT_MS = Number(process.env.PPRO_COMMAND_TIMEOUT_MS || 60000);

const panels = new Map(); // app -> ws
const clients = new Set();
const pending = new Map(); // command id -> { clientWs, timer, command }

const log = (...a) => console.error(`[proxy ${new Date().toISOString()}]`, ...a);

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function settle(id, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  send(entry.clientWs, payload);
}

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on("listening", () => log(`listening on ws://${HOST}:${PORT}`));

wss.on("connection", (ws, req) => {
  ws.meta = { role: null, app: null, addr: req.socket.remoteAddress };
  log("connection from", ws.meta.addr);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", error: "malformed JSON" });
    }

    switch (msg.type) {
      case "register": {
        const role = msg.role === "panel" ? "panel" : "client";
        const app = msg.app || "premierepro";
        ws.meta.role = role;
        ws.meta.app = app;
        if (role === "panel") {
          const prev = panels.get(app);
          if (prev && prev !== ws) {
            log(`replacing existing panel for ${app}`);
            send(prev, { type: "displaced" });
          }
          panels.set(app, ws);
        } else {
          clients.add(ws);
        }
        log(`registered ${role} (${app})`);
        return send(ws, {
          type: "registered",
          role,
          app,
          panelConnected: panels.has(app),
        });
      }

      case "command": {
        if (ws.meta.role !== "client") {
          return send(ws, { type: "error", error: "only clients send commands" });
        }
        const app = msg.app || "premierepro";
        const panel = panels.get(app);
        if (!panel) {
          return send(ws, {
            type: "response",
            id: msg.id,
            ok: false,
            error: `no ${app} panel connected — open the panel in Premiere (Window > Extensions)`,
          });
        }
        const timer = setTimeout(() => {
          settle(msg.id, {
            type: "response",
            id: msg.id,
            ok: false,
            error: `panel did not respond to "${msg.command}" within ${COMMAND_TIMEOUT_MS}ms`,
          });
        }, COMMAND_TIMEOUT_MS);
        pending.set(msg.id, { clientWs: ws, timer, command: msg.command });
        log(`-> panel ${msg.command} (${msg.id})`);
        return send(panel, { type: "command", id: msg.id, command: msg.command, params: msg.params || {} });
      }

      case "response": {
        if (ws.meta.role !== "panel") {
          return send(ws, { type: "error", error: "only the panel sends responses" });
        }
        log(`<- panel ${msg.id} ok=${msg.ok}`);
        return settle(msg.id, { ...msg, type: "response" });
      }

      case "ping":
        return send(ws, { type: "pong", t: Date.now() });

      default:
        return send(ws, { type: "error", error: `unknown message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    if (ws.meta.role === "panel" && panels.get(ws.meta.app) === ws) {
      panels.delete(ws.meta.app);
      log(`panel for ${ws.meta.app} disconnected`);
    }
    clients.delete(ws);
    // Fail anything this socket was waiting on rather than leaking it.
    for (const [id, entry] of pending) {
      if (entry.clientWs === ws) {
        clearTimeout(entry.timer);
        pending.delete(id);
      }
    }
  });

  ws.on("error", (e) => log("socket error:", e.message));
});

wss.on("error", (e) => {
  log("server error:", e.message);
  process.exit(1);
});
