// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // по умолчанию нормально; можно настроить CORS если нужно
  // maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname, "public")));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const MAX_STROKES = 5000; // мягкий cap: сколько всего хранить на сервере
const PRUNE_TO = 4000;    // при переполнении обрезаем до этого количества

// ---- Storage: strokes map ----
// strokes: Map<strokeId -> { strokeId, clientId, points: [{x,y}], color, size, isEraser }>
const strokes = new Map();
let strokeCounter = 1;

// Helper: produce array of strokes (ordered by strokeId ascending)
function getAllStrokesArray() {
  return Array.from(strokes.values()).sort((a, b) => a.strokeId - b.strokeId);
}

// Prune oldest strokes if too many
function ensureSizeLimit() {
  if (strokes.size <= MAX_STROKES) return;
  const arr = getAllStrokesArray();
  const toRemove = arr.length - PRUNE_TO;
  for (let i = 0; i < toRemove; i++) {
    strokes.delete(arr[i].strokeId);
  }
}

// ---- Socket.IO handlers ----
io.on("connection", socket => {
  console.log("Client connected:", socket.id);

  // send current authoritative strokes list
  socket.emit("init", getAllStrokesArray());

  // client sends a stroke
  // payload: { points: [{x,y},...], color, size, isEraser }
  socket.on("stroke", (payload, ack) => {
    try {
      if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
        if (ack) ack({ ok: false, reason: "bad payload" });
        return;
      }
      const strokeId = strokeCounter++;
      const st = {
        strokeId,
        clientId: socket.id,
        points: payload.points,
        color: payload.color || "#000000",
        size: Math.max(1, Math.min(200, payload.size || 4)),
        isEraser: !!payload.isEraser,
        t: Date.now()
      };
      strokes.set(strokeId, st);
      ensureSizeLimit();
      // broadcast to others
      socket.broadcast.emit("stroke", st);
      if (ack) ack({ ok: true, strokeId });
    } catch (err) {
      console.error("stroke error:", err);
      if (ack) ack({ ok: false, reason: "exception" });
    }
  });

  // cursor / pointer update from client (throttled on client)
  // payload: { x,y, color, size, isEraser }
  socket.on("cursor", (payload) => {
    // broadcast to others, but don't persist
    socket.broadcast.emit("cursor", { clientId: socket.id, ...payload });
  });

  // Undo: request to remove last stroke by this client OR globally?
  // We agreed: undo is global (user triggers undo -> remove last stroke globally)
  socket.on("undo", () => {
    // pop the last stroke (highest strokeId)
    const arr = getAllStrokesArray();
    if (arr.length === 0) return;
    const last = arr[arr.length - 1];
    strokes.delete(last.strokeId);
    // send new authoritative list
    io.emit("init", getAllStrokesArray());
  });

  // client requested full re-sync
  socket.on("requestFull", () => {
    socket.emit("init", getAllStrokesArray());
  });

  socket.on("disconnect", () => {
    // notify others to remove cursors for this client
    socket.broadcast.emit("cursor_remove", { clientId: socket.id });
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running at:");
  console.log(`→ http://localhost:${PORT} (на этом компьютере)`);
  console.log(`→ http://26.4.244.209:${PORT} (для телефона в той же сети)`);
});

