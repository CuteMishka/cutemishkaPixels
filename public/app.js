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

// Нужна альфа для корректной работы destination-out (ластик)
const ctx = canvas.getContext("2d", { alpha: true });


function fitCanvasToWindow() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
fitCanvasToWindow();
window.addEventListener("resize", () => { fitCanvasToWindow(); requestRedraw(); });

/* world transform (local to each client) */
let scale = 1;                 // zoom (1 = 100%)
let offsetX = 0, offsetY = 0;  // pan offset in screen pixels (applied after scale)
const MIN_SCALE = 0.1, MAX_SCALE = 40;

/* drawing state */
let isPointerDown = false;
let isPanning = false;
let panStart = null; // хранит экранные координаты начала панорамирования
let isRightButton = false;


let pointers = new Map(); // active pointers by pointerId (for pinch)
let lastPointerScreen = null; // last pointer screen coords for single-pointer drawing or pan
let currentStroke = null;     // { points: [{x,y},...], color, size, isEraser }
let localStrokeIds = [];      // local stack of strokeIds returned by server (for potential future local mapping)

/* tool state (UI should set these) */
let brushColor = "#000000";
let brushSize = 6;
let isEraser = false;

/* authoritative strokes array (kept in sync with server via "init") */
let strokes = []; // array of stroke objects { strokeId, points, color, size, isEraser }

/* other users cursors (transient) */
const otherCursors = new Map(); // clientId -> { xScreen, yScreen, size, color, isEraser, lastSeen }

/* redraw control */
let redrawPending = false;
function requestRedraw() {
  if (!redrawPending) {
    redrawPending = true;
    requestAnimationFrame(redraw);
  }
}

/* ---------- Coordinate helpers ---------- */
/* Convert screen/client coordinates to world coordinates (absolute positions used for strokes)
   worldX/worldY are in device pixels (no DPR adjustment necessary because both client and server
   use same canvas pixel coords) */
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
    // destination-out реально удаляет пиксели (требует alpha: true у контекста)
    localCtx.globalCompositeOperation = "destination-out";
    localCtx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    localCtx.globalCompositeOperation = "source-over";
    localCtx.strokeStyle = stroke.color;
  }

  // НЕ умножаем на scale: transform уже применён на ctx перед вызовом drawStrokeToCtx
  localCtx.lineWidth = stroke.size;

  localCtx.beginPath();
  const pts = stroke.points;
  localCtx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    localCtx.lineTo(pts[i].x, pts[i].y);
  }
  localCtx.stroke();
  localCtx.restore();
}




/* Full redraw: clear and re-render all strokes respecting current transform */
function redraw() {
  redrawPending = false;
  // clear
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // apply world transform
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);

  // draw strokes (in world coordinates)
  for (const st of strokes) {
    drawStrokeToCtx(ctx, st);
  }

  // draw current stroke (if drawing) on top (already in world coords)
  if (currentStroke) {
    drawStrokeToCtx(ctx, currentStroke);
  }

  // reset transform to draw overlay (screen-space)
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // draw other users' cursors (screen-space)
  const now = Date.now();
  for (const [clientId, cur] of otherCursors.entries()) {
    // remove stale cursors (not seen for 4s)
    if (now - cur.lastSeen > 4000) { otherCursors.delete(clientId); continue; }
    // draw circle
    ctx.beginPath();
    ctx.strokeStyle = cur.isEraser ? "rgba(0,0,0,0.5)" : cur.color;
    ctx.lineWidth = 2;
    ctx.fillStyle = cur.isEraser ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.05)";
    ctx.arc(cur.xScreen, cur.yScreen, Math.max(4, cur.size/2), 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  }

  // draw our local brush preview (screen-space)
  if (lastPointerScreen) {
    ctx.beginPath();
    ctx.strokeStyle = isEraser ? "rgba(0,0,0,0.6)" : brushColor;
    ctx.lineWidth = 2;
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

socket.on("init", (arr) => {
  // authoritative list of strokes (array)
  if (!Array.isArray(arr)) return;
  strokes = arr;
  requestRedraw();
});

socket.on("stroke", (st) => {
  if (!st || !Array.isArray(st.points)) return;
  strokes.push(st);
  requestRedraw();
});

socket.on("cursor", (payload) => {
  if (!payload || !payload.clientId) return;
  // payload: { clientId, x, y, color, size, isEraser }
  const screen = { x: payload.x, y: payload.y };
  otherCursors.set(payload.clientId, {
    xScreen: screen.x,
    yScreen: screen.y,
    color: payload.color || "#000000",
    size: payload.size || 6,
    isEraser: !!payload.isEraser,
    lastSeen: Date.now()
  });
  requestRedraw();
});

socket.on("cursor_remove", ({ clientId }) => {
  otherCursors.delete(clientId);
  requestRedraw();
});

/* ---------- Pointer / touch / wheel handling (uses Pointer Events) ---------- */
canvas.style.touchAction = "none"; // prevent browser gestures
let isPinching = false;
let pinchStart = null;
let lastScale = scale;

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

  if (pointers.size === 2) {
    // start pinch
    isPinching = true;
    // record initial distance and midpoint
    const it = Array.from(pointers.values());
    const a = it[0], b = it[1];
    const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
        pinchStart = { dist: Math.hypot(dx, dy), mid: { x: (a.clientX + b.clientX)/2, y: (a.clientY + b.clientY)/2 }, scaleStart: scale, offsetStart: { x: offsetX, y: offsetY } };
    lastScale = scale;
    return;
  }
  // если один палец и не рисуем, включаем пан (например, два пальца — зум, один палец без рисования — пан)
if (e.pointerType === "touch" && e.buttons === 0) {
  isPanning = true;
  panStart = { x: e.clientX, y: e.clientY };
  return;
}

  // single-pointer start: decide draw vs pan (right button => pan)
  lastPointerScreen = { x: e.clientX, y: e.clientY, id: e.pointerId };
  if (e.button === 2) { // right mouse -> pan
    isPanning = true;
  } else {
    // start drawing stroke
    const w = screenToWorld(e.clientX, e.clientY);
    currentStroke = { points: [ w ], color: isEraser ? "#ffffff" : brushColor, size: brushSize, isEraser: !!isEraser };
    // send initial cursor so others see us
    socket.emit("cursor", { clientId: socket.id, x: e.clientX, y: e.clientY, color: brushColor, size: brushSize, isEraser: !!isEraser });
  }
  requestRedraw();
});

canvas.addEventListener("pointermove", (e) => {
  // показываем/обновляем белый кружок справа от курсора, если не в режиме панорамирования
if (!isPanning) {
  brushCursor.style.display = "block";
  const rect = canvas.getBoundingClientRect();
  // ставим немного правее курсора
  brushCursor.style.left = (e.clientX + 12) + "px";
  brushCursor.style.top = (e.clientY - (brushSize / 2)) + "px";
  // размер в px — можно подогнать под визуал: здесь используем brushSize (в world units),
  // но отображаем в screen pixels — подганяем через scale, но ограничиваем минимум
  const cursorSize = Math.max(6, brushSize);
  brushCursor.style.width = cursorSize + "px";
  brushCursor.style.height = cursorSize + "px";
  brushCursor.style.border = isEraser ? "2px solid red" : "2px solid white";
} else {
  brushCursor.style.display = "none";
}

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

  // update last screen point for preview and cursor broadcasting
  lastPointerScreen = { x: e.clientX, y: e.clientY };
  // broadcast cursor occasionally (throttled by interval below) - we still update local preview immediately
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

  if (isPinching && pointers.size >= 2) {
    // handle pinch zoom + translate to keep midpoint stable
    const it = Array.from(pointers.values());
    const a = it[0], b = it[1];
    const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
    const dist = Math.hypot(dx, dy);
    if (pinchStart && pinchStart.dist > 0) {
      const factor = dist / pinchStart.dist;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStart.scaleStart * factor));
      // keep midpoint stable: convert pinchStart.mid screen -> world before, after adjust offset so the same world point stays at the same screen point
      const mid = { x: (a.clientX + b.clientX)/2, y: (a.clientY + b.clientY)/2 };
      const worldAtMid_before = screenToWorld(pinchStart.mid.x, pinchStart.mid.y);
      scale = newScale;
      // compute new offset to keep worldAtMid_before at same screen coords (mid)
      offsetX = mid.x - worldAtMid_before.x * scale;
      offsetY = mid.y - worldAtMid_before.y * scale;
      requestRedraw();
    }
    return;
  }

  if (isPanning) {
    // pan with mouse
    if (lastPointerScreen) {
      const dx = e.clientX - lastPointerScreen.x;
      const dy = e.clientY - lastPointerScreen.y;
      offsetX += dx;
      offsetY += dy;
      lastPointerScreen = { x: e.clientX, y: e.clientY, id: e.pointerId };
      requestRedraw();
    }
    return;
  }

  // drawing with single pointer
  if (currentStroke && !isPinching && !isPanning) {
    const last = currentStroke.points[currentStroke.points.length - 1];
    const world = screenToWorld(e.clientX, e.clientY);
    // avoid pushing many identical points (throttle by pixel)
    const dx = world.x - last.x, dy = world.y - last.y;
    if ((dx*dx + dy*dy) >= 0.25) { // >0.5px move squared
      currentStroke.points.push(world);
      // draw incremental segment locally for smoothness (draw using world coords with transform)
      // We'll draw directly onto main ctx (transform already applied in redraw), but for speed draw small segment:
      ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
      drawStrokeToCtx(ctx, { points: [ last, world ], color: currentStroke.color, size: currentStroke.size, isEraser: currentStroke.isEraser });
      // reset transform for overlays
      ctx.setTransform(1,0,0,1,0,0);
    }
  }
});
/* ---------- Touch move (two-finger pan on mobile) ---------- */



canvas.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) {
    delete canvas.dataset.touchMidX;
    delete canvas.dataset.touchMidY;
  }
});

canvas.addEventListener("pointerup", (e) => {
  
  if (isRightButton) {
  isRightButton = false;
  isPanning = false;
  panStart = null;
  return;
}

  canvas.releasePointerCapture(e.pointerId);
  pointers.delete(e.pointerId);
  if (isPanning) {
  isPanning = false;
  panStart = null;
}

  if (pointers.size < 2 && isPinching) {
    isPinching = false;
    pinchStart = null;
  }

  if (isPanning && e.button === 2) {
    isPanning = false;
    lastPointerScreen = null;
    requestRedraw();
    return;
  }

  // finish drawing if we had an active stroke and no more pointers (or pointer that started stroke ended)
  if (currentStroke) {
    // ensure at least two points (or single-point stroke)
    if (currentStroke.points.length >= 1) {
      // store authoritative stroke in local array immediately (server will broadcast back)
      // mark a temporary strokeId = null until server acks
      strokes.push({ strokeId: null, points: currentStroke.points.slice(), color: currentStroke.color, size: currentStroke.size, isEraser: !!currentStroke.isEraser });
      requestRedraw();
      // send to server
      const strokeCopy = {
  points: currentStroke.points.slice(),
  color: currentStroke.color,
  size: currentStroke.size,
  isEraser: !!currentStroke.isEraser
};
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

      // push server-global undo stack is handled server-side; client keeps visual strokes array in sync via 'init' or 'stroke' events
    }
    currentStroke = null;
  }

  // send cursor removal for this pointer if none left
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
    isPinching = false;
    isPanning = false;
    socket.emit("cursor_remove", { clientId: socket.id });
    lastPointerScreen = null;
    requestRedraw();
  }
});

/* wheel -> zoom at cursor (mouse wheel) */
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY;
  const before = screenToWorld(sx, sy);
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
  // after scaling, set offset so that world point 'before' remains under cursor
  offsetX = sx - before.x * scale;
  offsetY = sy - before.y * scale;
  requestRedraw();
}, { passive: false });
/* ---------- Touch zoom (pinch) with smooth animation ---------- */
let lastTouchDistance = 0;
let targetScale = scale;
let zoomAnimating = false;

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function smoothZoom() {
  if (!zoomAnimating) return;
  scale += (targetScale - scale) * 0.2; // плавное приближение
  if (Math.abs(targetScale - scale) < 0.001) {
    scale = targetScale;
    zoomAnimating = false;
  }
  requestRedraw();
  requestAnimationFrame(smoothZoom);
}

canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    lastTouchDistance = getTouchDistance(e.touches);
  }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const newDistance = getTouchDistance(e.touches);
    const zoomFactor = newDistance / lastTouchDistance;
    lastTouchDistance = newDistance;

    const rect = canvas.getBoundingClientRect();
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;

    const worldX = (midX - offsetX) / scale;
    const worldY = (midY - offsetY) / scale;

    targetScale = Math.min(Math.max(scale * zoomFactor, MIN_SCALE), MAX_SCALE);
    offsetX = midX - worldX * targetScale;
    offsetY = midY - worldY * targetScale;

    if (!zoomAnimating) {
      zoomAnimating = true;
      requestAnimationFrame(smoothZoom);
    }
  }
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) {
    lastTouchDistance = 0;
    zoomAnimating = false;
  }
}, { passive: false });
/* ---------- Two-finger pan on mobile (без конфликта с pinch zoom) ---------- */
let prevMid = null;

canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && !zoomAnimating) {
    if (Math.abs(lastTouchDistance - getTouchDistance(e.touches)) > 5) return; 
    e.preventDefault();
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

    if (prevMid) {
      offsetX += (midX - prevMid.x);
      offsetY += (midY - prevMid.y);
      requestRedraw();
    }
    prevMid = { x: midX, y: midY };
  }
}, { passive: false });

canvas.addEventListener("touchend", () => { prevMid = null; });

let spaceDown = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") { spaceDown = true; canvas.style.cursor = "grab"; e.preventDefault(); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") { spaceDown = false; canvas.style.cursor = "default"; }
});

/* ---------- UI hookups (color, size, eraser, undo) ---------- */
document.getElementById("colorPicker")?.addEventListener("input", (e) => { brushColor = e.target.value; });
document.getElementById("brushSize")?.addEventListener("input", (e) => { brushSize = Math.max(1, parseInt(e.target.value) || 1); requestRedraw(); });
const eraserBtn = document.getElementById("eraser");
const brushBtn = document.getElementById("brush");

eraserBtn?.addEventListener("click", () => {
  isEraser = true;
  eraserBtn.classList.add("active");
  brushBtn.classList.remove("active");
});

brushBtn?.addEventListener("click", () => {
  isEraser = false;
  brushBtn.classList.add("active");
  eraserBtn.classList.remove("active");
});

document.getElementById("undoBtn")?.addEventListener("click", () => { socket.emit("undo"); }); // global undo

/* ---------- Cursor broadcast (throttle) ---------- */
setInterval(() => {
  if (!lastPointerScreen) return;
  socket.emit("cursor", { clientId: socket.id, x: lastPointerScreen.x, y: lastPointerScreen.y, color: brushColor, size: brushSize, isEraser: !!isEraser });
}, 80); // ~12.5Hz updates

/* ---------- Server sync helpers ---------- */
// when server broadcasts a stroke from others
socket.on("stroke", (s) => {
  if (!s || !Array.isArray(s.points)) return;
  // server may supply strokeId, color, size
  strokes.push({ strokeId: s.strokeId || null, points: s.points, color: s.color, size: s.size, isEraser: !!s.isEraser });
  requestRedraw();
});

// server authoritative init (full state)
socket.on("init", (arr) => {
  if (!Array.isArray(arr)) return;
  strokes = arr.map(s => ({ strokeId: s.strokeId || null, points: s.points, color: s.color, size: s.size, isEraser: !!s.isEraser }));
  requestRedraw();
});

// server may ask to apply full pixels / state (compat)
socket.on("applyPixels", (pixels) => {
  // backward-compat: ignore if not array; else we don't implement pixel-level apply in this client (server handles tiles)
  if (!Array.isArray(pixels)) return;
});

/* ---------- Initial request for state ---------- */
socket.on("connect", () => {
  socket.emit("requestFullState"); // request authoritative strokes/tiles depending on server implementation
});

/* ---------- Utility: redraw on animation frame loop if requested ---------- */
(function renderLoop() {
  if (redrawPending) redraw();
  requestAnimationFrame(renderLoop);
})();
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerleave", () => { brushCursor.style.display = "none"; });
canvas.addEventListener("pointerup", () => { if (!isPanning) brushCursor.style.display = "block"; });
canvas.addEventListener("pointerdown", () => { brushCursor.style.display = "none"; });
