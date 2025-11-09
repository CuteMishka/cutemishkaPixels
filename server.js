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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, "public")));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const MAX_STROKES = 5000;
const PRUNE_TO = 4000;

// ---- Storage: strokes map ----
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

  // Send current authoritative strokes list
  socket.emit("init", getAllStrokesArray());

  // Client sends a stroke
  socket.on("stroke", (payload, ack) => {
    try {
      if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
        if (ack) ack({ ok: false, reason: "bad payload" });
        return;
      }
      
      const strokeId = strokeCounter++;
      const st = {
        strokeId,
        clientId: payload.clientId || socket.id,
        points: payload.points,
        color: payload.color || "#000000",
        size: Math.max(1, Math.min(200, payload.size || 6)),
        isEraser: !!payload.isEraser,
        t: Date.now()
      };
      
      strokes.set(strokeId, st);
      ensureSizeLimit();
      
      // Broadcast to others
      socket.broadcast.emit("stroke", st);
      
      if (ack) ack({ ok: true, strokeId });
    } catch (err) {
      console.error("stroke error:", err);
      if (ack) ack({ ok: false, reason: "exception" });
    }
  });

  // Cursor update from client
  socket.on("cursor", (payload) => {
    socket.broadcast.emit("cursor", { clientId: socket.id, ...payload });
  });

  // Cursor remove
  socket.on("cursor_remove", (payload) => {
    socket.broadcast.emit("cursor_remove", { clientId: socket.id });
  });

  // Undo: remove last stroke by THIS client only
  socket.on("undo", (payload) => {
    const clientId = payload?.clientId || socket.id;
    
    // Find all strokes by this client
    const clientStrokes = getAllStrokesArray().filter(st => st.clientId === clientId);
    
    if (clientStrokes.length === 0) {
      console.log(`No strokes to undo for client ${clientId}`);
      return;
    }
    
    // Remove the last stroke by this client
    const lastStroke = clientStrokes[clientStrokes.length - 1];
    strokes.delete(lastStroke.strokeId);
    
    console.log(`Undo: removed stroke ${lastStroke.strokeId} by client ${clientId}`);
    
    // Send updated list to everyone
    io.emit("init", getAllStrokesArray());
  });

  // Client requested full re-sync
  socket.on("requestFull", () => {
    socket.emit("init", getAllStrokesArray());
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("cursor_remove", { clientId: socket.id });
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running at:");
  console.log(`→ http://localhost:${PORT} (на этом компьютере)`);
  console.log(`→ http://26.4.244.209:${PORT} (для телефона в той же сети)`);
});