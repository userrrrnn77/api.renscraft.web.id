import { WebSocketServer } from "ws";
import { getJwtSecret } from "./env.js";
import { verifyAdminSession } from "../utils/jwt.js";

let wss = null;
const adminClients = new Set();

export function initWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    console.log(`[WS] Upgrade request masuk: ${request.url}`);
    const url = new URL(request.url, `http://${request.headers.host}`);

    // Pake startsWith biar aman kalau ada trailing slash
    if (!url.pathname.startsWith("/api/admin/ws")) {
      console.log(`[WS] Path ditolak: ${url.pathname}`);
      socket.destroy();
      return;
    }

    const cookieHeader = request.headers.cookie || "";
    const match = cookieHeader.match(/admin_token=([^;]+)/);

    if (!match) {
      console.log(`[WS] Cookie admin_token tidak ditemukan di header!`);
      socket.destroy();
      return;
    }

    try {
      const token = match[1];
      verifyAdminSession(token)
      console.log(`[WS] Token valid, membuka koneksi...`);

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } catch (err) {
      console.log(`[WS] Token invalid: ${err.message}`);
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    adminClients.add(ws);
    console.log(`[WS] Admin terhubung. Total: ${adminClients.size}`);

    ws.on("close", () => {
      adminClients.delete(ws);
      console.log(`[WS] Admin terputus. Total: ${adminClients.size}`);
    });
  });
}

export function notifyAdmin(data) {
  if (!wss || adminClients.size === 0) return;
  const payload = JSON.stringify(data);
  for (const client of adminClients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}
