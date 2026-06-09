import { Router, type IRouter } from "express";
import { Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { logger } from "../lib/logger";
import * as os from "os";
import { spawn as spawnChild, type ChildProcess } from "child_process";
import { authenticate } from "../middleware/authenticate";

export const terminalRouterAPI: IRouter = Router();

interface TerminalSession {
  id: string;
  name: string;
  created_at: string;
  status: string;
  child?: ChildProcess;
  clients: Set<WebSocket>;
  usePty: boolean;
  ptyProcess?: any;
}

const sessions = new Map<string, TerminalSession>();
const isWindows = os.platform() === "win32";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function getShell(): { shell: string; args: string[] } {
  if (isWindows) return { shell: "cmd.exe", args: [] };
  const candidates = ["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"];
  for (const s of candidates) {
    try { const fs = require("fs"); if (fs.existsSync(s)) return { shell: s, args: ["-i"] }; } catch {}
  }
  return { shell: "/bin/sh", args: [] };
}

terminalRouterAPI.get("/terminal/sessions", authenticate, async (_req: Request, res: Response): Promise<void> => {
  const list = Array.from(sessions.values()).map((s) => ({
    id: s.id, name: s.name, created_at: s.created_at, status: s.status,
  }));
  res.json(list);
});

terminalRouterAPI.post("/terminal/sessions", authenticate, async (req: Request, res: Response): Promise<void> => {
  const { name = "Terminal", cwd } = req.body;
  const id = generateId();
  const session: TerminalSession = {
    id, name: name || "Terminal",
    created_at: new Date().toISOString(),
    status: "running",
    clients: new Set(),
    usePty: false,
  };

  const workDir = cwd || (isWindows ? process.env.USERPROFILE || "C:\\" : process.env.HOME || "/tmp");
  const { shell, args } = getShell();

  let ptyAvailable = false;
  let pty: any;
  try {
    pty = await import("node-pty");
    ptyAvailable = true;
  } catch {
    ptyAvailable = false;
  }

  if (ptyAvailable && pty) {
    try {
      const ptyProcess = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: workDir,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } as Record<string, string>,
      });
      session.ptyProcess = ptyProcess;
      session.usePty = true;

      ptyProcess.onData((data: string) => {
        const msg = JSON.stringify({ type: "output", data });
        session.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      });

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        session.status = "exited";
        const msg = JSON.stringify({ type: "exit" });
        session.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      });

      logger.info({ id, shell, method: "pty" }, "Terminal created (PTY)");
    } catch (err) {
      logger.warn({ err }, "PTY spawn failed, falling back to child_process");
      ptyAvailable = false;
    }
  }

  if (!session.usePty) {
    try {
      const child = spawnChild(shell, args.length > 0 ? args : [], {
        cwd: workDir,
        env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      session.child = child;

      child.stdout?.on("data", (data: Buffer) => {
        const msg = JSON.stringify({ type: "output", data: data.toString("utf8") });
        session.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      });

      child.stderr?.on("data", (data: Buffer) => {
        const msg = JSON.stringify({ type: "output", data: data.toString("utf8") });
        session.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      });

      child.on("close", () => {
        session.status = "exited";
        const msg = JSON.stringify({ type: "exit" });
        session.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      });

      child.on("error", (err) => {
        logger.error({ err }, "Child process error");
        session.status = "exited";
        const msg = JSON.stringify({ type: "exit" });
        session.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      });

      logger.info({ id, shell, method: "child_process" }, "Terminal created (child_process)");
    } catch (err) {
      logger.error({ err }, "Failed to create terminal");
      res.status(500).json({ error: "Failed to create terminal session" });
      return;
    }
  }

  sessions.set(id, session);
  res.status(201).json({ id, name: session.name, created_at: session.created_at, status: session.status });
});

terminalRouterAPI.delete("/terminal/sessions/:id", authenticate, async (req: Request, res: Response): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const session = sessions.get(rawId);
  if (!session) { res.status(404).json({ success: false, message: "Session not found" }); return; }
  try {
    if (session.usePty && session.ptyProcess) session.ptyProcess.kill();
    else if (session.child) session.child.kill("SIGTERM");
    session.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) { c.send(JSON.stringify({ type: "exit" })); c.close(); }
    });
    sessions.delete(rawId);
    res.json({ success: true, message: "Session killed" });
  } catch (err) {
    logger.error({ err }, "Failed to kill session");
    res.status(500).json({ success: false, message: "Failed to kill session" });
  }
});

export function setupTerminalWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url || "";
    const match = url.match(/\/api\/terminal\/ws\/([^/?]+)/);
    if (!match) { ws.close(); return; }

    const sessionId = match[1];
    const session = sessions.get(sessionId);
    if (!session) { ws.close(); return; }

    session.clients.add(ws);
    logger.info({ sessionId }, "WS connected to terminal");

    ws.on("message", (rawMsg: Buffer) => {
      try {
        const msg = JSON.parse(rawMsg.toString());
        if (msg.type === "input" && msg.data) {
          if (session.usePty && session.ptyProcess) session.ptyProcess.write(msg.data);
          else if (session.child?.stdin?.writable) session.child.stdin.write(msg.data);
        } else if (msg.type === "resize") {
          if (session.usePty && session.ptyProcess && msg.cols && msg.rows) {
            try { session.ptyProcess.resize(msg.cols, msg.rows); } catch {}
          }
        } else if (msg.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch (err) {
        logger.warn({ err }, "Failed to parse terminal message");
      }
    });

    ws.on("close", () => {
      session.clients.delete(ws);
    });

    ws.on("error", (err) => {
      logger.error({ err, sessionId }, "WebSocket error");
      session.clients.delete(ws);
    });
  });
}

export default terminalRouterAPI;
