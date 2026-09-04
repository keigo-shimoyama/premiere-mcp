/**
 * Thin client onto the proxy. Owns reconnection and request/response
 * correlation so the tool handlers can just await a plain call.
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const URL = process.env.PPRO_PROXY_URL || "ws://127.0.0.1:3001";
const CALL_TIMEOUT_MS = Number(process.env.PPRO_CALL_TIMEOUT_MS || 65000);

export class ProxyClient {
  #ws = null;
  #ready = null;
  #pending = new Map();

  async #connect() {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      const failFast = (e) => {
        this.#ready = null;
        reject(new Error(`cannot reach proxy at ${URL} — is "npm run proxy" running? (${e.message})`));
      };
      ws.once("error", failFast);
      ws.on("open", () => {
        ws.off("error", failFast);
        ws.send(JSON.stringify({ type: "register", role: "client", app: "premierepro" }));
      });
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "registered") {
          this.#ws = ws;
          return resolve(ws);
        }
        if (msg.type !== "response") return;
        const entry = this.#pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.#pending.delete(msg.id);
        msg.ok ? entry.resolve(msg.result) : entry.reject(new Error(msg.error));
      });
      ws.on("close", () => {
        this.#ws = null;
        this.#ready = null;
        for (const [, entry] of this.#pending) entry.reject(new Error("proxy connection closed"));
        this.#pending.clear();
      });
      ws.on("error", (e) => {
        for (const [, entry] of this.#pending) entry.reject(e);
        this.#pending.clear();
      });
    });
    return this.#ready;
  }

  async call(command, params = {}) {
    const ws = await this.#connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out waiting for "${command}"`));
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "command", id, command, params, app: "premierepro" }));
    });
  }
}
