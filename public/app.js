// public/app.js
"use strict";

/* ---------- Socket ---------- */
const socket = io();

/* ---------- Canvas and state ---------- */
const canvas = document.getElementById("canvas");
const brushCursor = document.createElement("div");
brushCursor.style.position = "fixed";
brushCursor.style.pointerEvents = "none";
brushCursor.style.border = "2px solid white";
brushCursor.style.borderRadius = "50%";
brushCursor.style.width = "10px";
brushCursor.style.height = "10px";
brushCursor.style.zIndex = "10000";
brushCursor.style.display = "none";
document.body.appendChild(brushCursor);

const ctx = canvas.getContext("2d", { alpha: true });

function fitCanvasToWindow() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
fitCanvasToWindow();
window.addEventListener("resize", () => { fitCanvasToWindow(); requestRedraw(); });

/* world transform */
let scale = 1;
let offsetX = 0, offsetY = 0;
const MIN_SCALE = 0.1, MAX_SCALE = 40;

/* drawing state */
let isPointerDown = false;
let isPanning = false;
let panStart = null;
let isRightButton = false;
let pointers = new Map();
let lastPointerScreen = null;
let currentStroke = null;
let localStrokeIds = [];

/* tool state */
let brushColor = "#000000";
let brushSize = 6;
let isEraser = false;
/* UI controls (подключаем) */
const colorPicker = document.getElementById("colorPicker");
const brushSizeInput = document.getElementById("brushSize");

if (colorPicker) {
  colorPicker.addEventListener("input", (e) => {
    brushColor = e.target.value;
  });
}
if (brushSizeInput) {
  brushSizeInput.addEventListener("input", (e) => {
    brushSize = Math.max(1, Number(e.target.value) || 1);
    // обновляем визуальный курсор если он видим
    if (brushCursor.style.display !== "none") {
      const cursorSize = Math.max(6, brushSize);
      brushCursor.style.width = cursorSize + "px";
      brushCursor.style.height = cursorSize + "px";
    }
  });
  // синхронизировать начальное значение
  brushSize = Number(brushSizeInput.value) || brushSize;
}

/* authoritative strokes */
let strokes = [];

/* other users cursors */
const otherCursors = new Map();

/* redraw control */
let redrawPending = false;
function requestRedraw() {
  if (!redrawPending) {
    redrawPending = true;
    requestAnimationFrame(redraw);
  }
}

/* ---------- Coordinate helpers ---------- */
function screenToWorld(sx, sy) {
  const rect = canvas.getBoundingClientRect();
  const x = (sx - rect.left) * (canvas.width / rect.width);
  const y = (sy - rect.top) * (canvas.height / rect.height);
  return { x: (x - offsetX) / scale, y: (y - offsetY) / scale };
}

function worldToScreen(wx, wy) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: wx * scale + offsetX + rect.left,
    y: wy * scale + offsetY + rect.top
  };
}

/* ---------- Draw helpers ---------- */
function drawStrokeToCtx(localCtx, stroke) {
  if (!stroke || !stroke.points || stroke.points.length === 0) return;
  localCtx.save();
  localCtx.lineJoin = "round";
  localCtx.lineCap = "round";
  if (stroke.isEraser) {
    localCtx.globalCompositeOperation = "destination-out";
    localCtx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    localCtx.globalCompositeOperation = "source-over";
    localCtx.strokeStyle = stroke.color;
  }
  localCtx.lineWidth = stroke.size;
  localCtx.beginPath();
  const pts = stroke.points;
  localCtx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) localCtx.lineTo(pts[i].x, pts[i].y);
  localCtx.stroke();
  localCtx.restore();
}

function redraw() {
  redrawPending = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  for (const st of strokes) drawStrokeToCtx(ctx, st);
  if (currentStroke) drawStrokeToCtx(ctx, currentStroke);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const now = Date.now();
  for (const [clientId, cur] of otherCursors.entries()) {
    if (now - cur.lastSeen > 4000) { otherCursors.delete(clientId); continue; }
    ctx.beginPath();
    ctx.strokeStyle = cur.isEraser ? "rgba(0,0,0,0.5)" : cur.color;
    ctx.lineWidth = Math.max(1, brushSize);

    ctx.fillStyle = cur.isEraser ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.05)";
    ctx.arc(cur.xScreen, cur.yScreen, Math.max(4, cur.size/2), 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  }

  if (lastPointerScreen) {
    ctx.beginPath();
    ctx.strokeStyle = isEraser ? "rgba(0,0,0,0.6)" : brushColor;
    ctx.lineWidth = Math.max(1, brushSize);

    ctx.fillStyle = isEraser ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.04)";
    ctx.arc(lastPointerScreen.x, lastPointerScreen.y, Math.max(4, brushSize/2), 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  }
}

/* ---------- Socket handlers ---------- */
socket.on("connect", () => {
  console.log("socket connected", socket.id);
  socket.emit("requestFull");
});
socket.on("init", (arr) => { if (Array.isArray(arr)) { strokes = arr; requestRedraw(); } });
socket.on("stroke", (st) => { if (st && Array.isArray(st.points)) { strokes.push(st); requestRedraw(); } });
socket.on("cursor", (payload) => {
  if (!payload || !payload.clientId) return;
  otherCursors.set(payload.clientId, {
    xScreen: payload.x,
    yScreen: payload.y,
    color: payload.color || "#000000",
    size: payload.size || 6,
    isEraser: !!payload.isEraser,
    lastSeen: Date.now()
  });
  requestRedraw();
});
socket.on("cursor_remove", ({ clientId }) => { otherCursors.delete(clientId); requestRedraw(); });

/* ---------- Pointer handling ---------- */
canvas.style.touchAction = "none";
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
function getPointersCentroid() {
  let sx = 0, sy = 0, n = 0;
  for (const p of pointers.values()) { sx += p.clientX; sy += p.clientY; n++; }
  if (n === 0) return null;
  return { x: sx / n, y: sy / n };
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 2) {
    isRightButton = true;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    return;
  }
  pointers.set(e.pointerId, e);
  const pt = { x: e.clientX, y: e.clientY, id: e.pointerId };

  // для тача — если не рисуем, то пан
  if (e.pointerType === "touch" && e.buttons === 0) {
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    return;
  }

  lastPointerScreen = { x: e.clientX, y: e.clientY, id: e.pointerId };
  if (e.button === 2) isPanning = true;
  else {
    const w = screenToWorld(e.clientX, e.clientY);
currentStroke = {
  points: [ w ],
  color: brushColor,         // цвет для обычной кисти (необязателен для ластика)
  size: brushSize,           // <- важно
  isEraser: !!isEraser
};
    socket.emit("cursor", { clientId: socket.id, x: e.clientX, y: e.clientY, color: brushColor, size: brushSize, isEraser });
  }
  requestRedraw();
});

canvas.addEventListener("pointermove", (e) => {
  if (!isPanning) {
    brushCursor.style.display = "block";
    brushCursor.style.left = (e.clientX + 12) + "px";
    brushCursor.style.top = (e.clientY - (brushSize / 2)) + "px";
    const cursorSize = Math.max(6, brushSize);
    brushCursor.style.width = cursorSize + "px";
    brushCursor.style.height = cursorSize + "px";
    brushCursor.style.border = isEraser ? "2px solid red" : "2px solid white";
  } else brushCursor.style.display = "none";

  if (isPanning && isRightButton && panStart) {
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    offsetX += dx;
    offsetY += dy;
    panStart = { x: e.clientX, y: e.clientY };
    requestRedraw();
    return;
  }

  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, e);
  lastPointerScreen = { x: e.clientX, y: e.clientY };
  requestRedraw();

  if (isPanning && panStart) {
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    offsetX += dx;
    offsetY += dy;
    panStart = { x: e.clientX, y: e.clientY };
    requestRedraw();
    return;
  }

  if (currentStroke && !isPanning) {
    const last = currentStroke.points[currentStroke.points.length - 1];
    const world = screenToWorld(e.clientX, e.clientY);
    const dx = world.x - last.x, dy = world.y - last.y;
    if ((dx*dx + dy*dy) >= 0.25) {
      currentStroke.points.push(world);
      ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
      drawStrokeToCtx(ctx, { points: [last, world], color: currentStroke.color, size: currentStroke.size, isEraser: currentStroke.isEraser });
      ctx.setTransform(1,0,0,1,0,0);
    }
  }
});

/* ---------- Two-finger pan (no pinch zoom) ---------- */
let panTouches = [];
canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    panTouches = [
      { x: e.touches[0].clientX, y: e.touches[0].clientY },
      { x: e.touches[1].clientX, y: e.touches[1].clientY }
    ];
  }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && panTouches.length === 2) {
    e.preventDefault();
    const t1 = e.touches[0], t2 = e.touches[1];
    const prevMid = { x: (panTouches[0].x + panTouches[1].x) / 2, y: (panTouches[0].y + panTouches[1].y) / 2 };
    const newMid = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
    const dx = newMid.x - prevMid.x;
    const dy = newMid.y - prevMid.y;
    offsetX += dx;
    offsetY += dy;
    requestRedraw();
    panTouches = [
      { x: t1.clientX, y: t1.clientY },
      { x: t2.clientX, y: t2.clientY }
    ];
  }
}, { passive: false });

canvas.addEventListener("touchend", () => { panTouches = []; });

canvas.addEventListener("pointerup", (e) => {
  if (isRightButton) {
    isRightButton = false;
    isPanning = false;
    panStart = null;
    return;
  }
  canvas.releasePointerCapture(e.pointerId);
  pointers.delete(e.pointerId);
  if (isPanning) { isPanning = false; panStart = null; }
  if (currentStroke) {
    if (currentStroke.points.length >= 1) {
      strokes.push({ strokeId: null, points: currentStroke.points.slice(), color: currentStroke.color, size: currentStroke.size, isEraser: currentStroke.isEraser });
      requestRedraw();
      const strokeCopy = { points: currentStroke.points.slice(), color: currentStroke.color, size: currentStroke.size, isEraser: currentStroke.isEraser };
      socket.emit("stroke", strokeCopy, (ack) => {
        if (ack && ack.strokeId) {
          for (let i = strokes.length - 1; i >= 0; i--) {
            if (strokes[i].strokeId === null && strokes[i].points.length === strokeCopy.points.length) {
              strokes[i].strokeId = ack.strokeId;
              break;
            }
          }
        }
      });
    }
    currentStroke = null;
  }
  if (pointers.size === 0) {
    socket.emit("cursor_remove", { clientId: socket.id });
    lastPointerScreen = null;
  }
  requestRedraw();
});

canvas.addEventListener("pointercancel", (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    currentStroke = null;
    isPanning = false;
    socket.emit("cursor_remove", { clientId: socket.id });
    lastPointerScreen = null;
    requestRedraw();
  }
});

/* wheel zoom */
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;
  const before = screenToWorld(sx, sy);
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
  offsetX = sx - before.x * scale;
  offsetY = sy - before.y * scale;
  requestRedraw();
}, { passive: false });

/* ---------- Zoom buttons ---------- */
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");

if (zoomInBtn && zoomOutBtn) {
  zoomInBtn.addEventListener("click", () => {
    const factor = 1.2;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const before = screenToWorld(cx, cy);
    scale = Math.min(MAX_SCALE, scale * factor);
    offsetX = cx - before.x * scale;
    offsetY = cy - before.y * scale;
    requestRedraw();
  });

  zoomOutBtn.addEventListener("click", () => {
    const factor = 1 / 1.2;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const before = screenToWorld(cx, cy);
    scale = Math.max(MIN_SCALE, scale * factor);
    offsetX = cx - before.x * scale;
    offsetY = cy - before.y * scale;
    requestRedraw();
  });
}
