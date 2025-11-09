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
window.addEventListener("resize", () => { 
  fitCanvasToWindow(); 
  requestRedraw(); 
});

/* world transform */
let scale = 1;
let offsetX = 0, offsetY = 0;
const MIN_SCALE = 0.1, MAX_SCALE = 40;

/* drawing state */
let isDrawing = false;
let isPanning = false;
let panStart = null;
let pointers = new Map();
let lastPointerScreen = null;
let currentStroke = null;

/* tool state */
let brushColor = "#ff0000";
let brushSize = 6;
let isEraser = false;

/* UI controls */
const colorPicker = document.getElementById("colorPicker");
const brushSizeInput = document.getElementById("brushSize");
const brushBtn = document.getElementById("brush");
const eraserBtn = document.getElementById("eraser");
const undoBtn = document.getElementById("undoBtn");
const menuToggle = document.getElementById("menuToggle");
const sidebar = document.getElementById("sidebar");
const toggleGrid = document.getElementById("toggleGrid");

/* Menu toggle for mobile */
if (menuToggle && sidebar) {
  menuToggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
  });
  
  // Close menu when clicking outside
  document.addEventListener("click", (e) => {
    if (sidebar.classList.contains("open") && 
        !sidebar.contains(e.target) && 
        e.target !== menuToggle) {
      sidebar.classList.remove("open");
    }
  });
}

/* Color picker */
if (colorPicker) {
  colorPicker.addEventListener("input", (e) => {
    brushColor = e.target.value;
    if (!isEraser) {
      updateToolButtons();
    }
  });
  brushColor = colorPicker.value;
}

/* Brush size */
const brushSizeValue = document.getElementById("brushSizeValue");
if (brushSizeInput) {
  brushSizeInput.addEventListener("input", (e) => {
    brushSize = Math.max(1, Number(e.target.value) || 1);
    if (brushSizeValue) {
      brushSizeValue.textContent = brushSize;
    }
    updateCursorSize();
  });
  brushSize = Number(brushSizeInput.value) || brushSize;
  if (brushSizeValue) {
    brushSizeValue.textContent = brushSize;
  }
}

/* Tool buttons */
function updateToolButtons() {
  if (brushBtn && eraserBtn) {
    if (isEraser) {
      eraserBtn.classList.add("active");
      brushBtn.classList.remove("active");
    } else {
      brushBtn.classList.add("active");
      eraserBtn.classList.remove("active");
    }
  }
}

if (brushBtn) {
  brushBtn.addEventListener("click", () => {
    isEraser = false;
    console.log("Кисть активирована"); // отладка
    updateToolButtons();
    updateCursorSize();
  });
}

if (eraserBtn) {
  eraserBtn.addEventListener("click", () => {
    isEraser = true;
    console.log("Ластик активирован"); // отладка
    updateToolButtons();
    updateCursorSize();
  });
}

/* Undo button */
if (undoBtn) {
  undoBtn.addEventListener("click", () => {
    socket.emit("undo", { clientId: socket.id });
  });
}

/* Keyboard shortcuts */
document.addEventListener("keydown", (e) => {
  // Ctrl+Z or Cmd+Z for undo
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    e.preventDefault();
    socket.emit("undo", { clientId: socket.id });
  }
});

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

/* ---------- Grid drawing ---------- */
let showGrid = true;
if (toggleGrid) {
  showGrid = toggleGrid.checked;
  toggleGrid.addEventListener("change", (e) => {
    showGrid = e.target.checked;
    requestRedraw();
  });
}

function drawGrid() {
  if (!showGrid) return;
  
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over"; // ВАЖНО: обычное рисование для сетки
  ctx.strokeStyle = "rgba(200, 200, 200, 0.3)";
  ctx.lineWidth = 1;
  
  const gridSize = 50 * scale;
  const startX = offsetX % gridSize;
  const startY = offsetY % gridSize;
  
  // Vertical lines
  for (let x = startX; x < canvas.width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  
  // Horizontal lines
  for (let y = startY; y < canvas.height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  
  ctx.restore();
}

/* ---------- Draw helpers ---------- */
function drawStrokeToCtx(localCtx, stroke) {
  if (!stroke || !stroke.points || stroke.points.length === 0) return;
  
  localCtx.save();
  localCtx.lineJoin = "round";
  localCtx.lineCap = "round";
  localCtx.lineWidth = stroke.size || 6;
  
  if (stroke.isEraser) {
    // КРИТИЧЕСКИ ВАЖНО: для ластика используем destination-out
    // Это удаляет пиксели, а не рисует черным
    localCtx.globalCompositeOperation = "destination-out";
    // Для destination-out цвет не имеет значения, важна только альфа
    localCtx.strokeStyle = "rgba(255,255,255,1)";
    
    // Отладка - выводим каждый 100-й штрих ластика
    if (Math.random() < 0.01) {
      console.log("🧹 Рисуем ластиком:", {
        compositeOp: localCtx.globalCompositeOperation,
        lineWidth: localCtx.lineWidth,
        points: stroke.points.length
      });
    }
  } else {
    // Обычное рисование
    localCtx.globalCompositeOperation = "source-over";
    localCtx.strokeStyle = stroke.color || "#000000";
  }
  
  localCtx.beginPath();
  const pts = stroke.points;
  localCtx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    localCtx.lineTo(pts[i].x, pts[i].y);
  }
  localCtx.stroke();
  localCtx.restore();
}

function redraw() {
  redrawPending = false;
  
  // ВАЖНО: Полностью очищаем канвас с альфа-каналом
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Заливаем белым фоном
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw grid
  drawGrid();
  
  // Draw strokes in world space
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  
  // Рисуем все штрихи по порядку
  for (const st of strokes) {
    drawStrokeToCtx(ctx, st);
  }
  
  // Рисуем текущий штрих
  if (currentStroke && isDrawing) {
    drawStrokeToCtx(ctx, currentStroke);
  }
  
  // Draw cursors in screen space
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  const now = Date.now();
  
  // Draw other users' cursors
  for (const [clientId, cur] of otherCursors.entries()) {
    if (now - cur.lastSeen > 4000) { 
      otherCursors.delete(clientId); 
      continue; 
    }
    ctx.beginPath();
    ctx.strokeStyle = cur.isEraser ? "rgba(255,0,0,0.6)" : (cur.color || "#000000");
    ctx.lineWidth = 2;
    ctx.fillStyle = cur.isEraser ? "rgba(255,100,100,0.3)" : "rgba(0,0,0,0.05)";
    const radius = Math.max(4, (cur.size || 6) / 2);
    ctx.arc(cur.xScreen, cur.yScreen, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  
  // Draw local cursor on canvas
  if (lastPointerScreen && !isPanning) {
    ctx.beginPath();
    ctx.strokeStyle = isEraser ? "rgba(255,0,0,0.7)" : brushColor;
    ctx.lineWidth = 2;
    ctx.fillStyle = isEraser ? "rgba(255,100,100,0.3)" : "rgba(0,0,0,0.05)";
    const radius = Math.max(4, brushSize / 2);
    ctx.arc(lastPointerScreen.x, lastPointerScreen.y, radius, 0, Math.PI * 2);
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
  if (Array.isArray(arr)) { 
    strokes = arr; 
    requestRedraw(); 
  } 
});

socket.on("stroke", (st) => { 
  if (st && Array.isArray(st.points)) { 
    strokes.push(st); 
    requestRedraw(); 
  } 
});

socket.on("cursor", (payload) => {
  if (!payload || !payload.clientId || payload.clientId === socket.id) return;
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

socket.on("cursor_remove", ({ clientId }) => { 
  otherCursors.delete(clientId); 
  requestRedraw(); 
});

/* ---------- Cursor helpers ---------- */
function updateCursorSize() {
  if (brushCursor.style.display !== "none") {
    const cursorSize = Math.max(8, brushSize);
    brushCursor.style.width = cursorSize + "px";
    brushCursor.style.height = cursorSize + "px";
    brushCursor.style.border = isEraser ? "2px solid red" : "2px solid white";
  }
}

function showBrushCursor(x, y) {
  brushCursor.style.display = "block";
  brushCursor.style.left = (x + 12) + "px";
  brushCursor.style.top = (y - (brushSize / 2)) + "px";
  updateCursorSize();
}

function hideBrushCursor() {
  brushCursor.style.display = "none";
}

/* ---------- Two-finger pan detection ---------- */
let isTwoFingerGesture = false;
let lastTwoFingerMid = null;

/* ---------- Pointer handling ---------- */
canvas.style.touchAction = "none";
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, e);
  
  // Right-click panning (desktop)
  if (e.button === 2) {
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY };
    hideBrushCursor();
    return;
  }
  
  // Two-finger touch detected (mobile pan)
  if (pointers.size === 2) {
    isTwoFingerGesture = true;
    isPanning = true;
    isDrawing = false;
    
    // Remove current stroke if started
    if (currentStroke) {
      currentStroke = null;
      requestRedraw();
    }
    
    // Calculate midpoint
    const pts = Array.from(pointers.values());
    lastTwoFingerMid = {
      x: (pts[0].clientX + pts[1].clientX) / 2,
      y: (pts[0].clientY + pts[1].clientY) / 2
    };
    
    hideBrushCursor();
    socket.emit("cursor_remove", { clientId: socket.id });
    lastPointerScreen = null;
    return;
  }
  
  // Single pointer drawing
  if (pointers.size === 1 && !isTwoFingerGesture && !isPanning) {
    isDrawing = true;
    const world = screenToWorld(e.clientX, e.clientY);
    
    // ВАЖНО: создаём объект штриха с правильным флагом ластика
    currentStroke = {
      points: [world],
      color: brushColor,
      size: brushSize,
      isEraser: isEraser, // берём текущее значение isEraser
      clientId: socket.id
    };
    
    console.log("Начало рисования:", isEraser ? "ЛАСТИК ✏️" : "КИСТЬ 🖌️", { 
      isEraser: currentStroke.isEraser,
      size: currentStroke.size,
      color: currentStroke.color 
    });
    
    lastPointerScreen = { x: e.clientX, y: e.clientY };
    
    // Send cursor position
    socket.emit("cursor", { 
      clientId: socket.id, 
      x: e.clientX, 
      y: e.clientY, 
      color: brushColor, 
      size: brushSize, 
      isEraser: isEraser
    });
    
    showBrushCursor(e.clientX, e.clientY);
  }
  
  requestRedraw();
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) {
    // Just hovering, show cursor
    if (!isPanning && pointers.size === 0) {
      lastPointerScreen = { x: e.clientX, y: e.clientY };
      showBrushCursor(e.clientX, e.clientY);
      requestRedraw();
    }
    return;
  }
  
  pointers.set(e.pointerId, e);
  
  // Two-finger panning
  if (isTwoFingerGesture && pointers.size === 2) {
    const pts = Array.from(pointers.values());
    const newMid = {
      x: (pts[0].clientX + pts[1].clientX) / 2,
      y: (pts[0].clientY + pts[1].clientY) / 2
    };
    
    if (lastTwoFingerMid) {
      const dx = newMid.x - lastTwoFingerMid.x;
      const dy = newMid.y - lastTwoFingerMid.y;
      offsetX += dx;
      offsetY += dy;
    }
    
    lastTwoFingerMid = newMid;
    requestRedraw();
    return;
  }
  
  // Right-click panning
  if (isPanning && panStart) {
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    offsetX += dx;
    offsetY += dy;
    panStart = { x: e.clientX, y: e.clientY };
    requestRedraw();
    return;
  }
  
  // Drawing
  if (isDrawing && currentStroke && !isPanning) {
    const last = currentStroke.points[currentStroke.points.length - 1];
    const world = screenToWorld(e.clientX, e.clientY);
    const dx = world.x - last.x;
    const dy = world.y - last.y;
    
    if ((dx * dx + dy * dy) >= 0.25) {
      currentStroke.points.push(world);
      
      // Redraw everything instead of incremental for eraser to work properly
      requestRedraw();
    }
    
    lastPointerScreen = { x: e.clientX, y: e.clientY };
    showBrushCursor(e.clientX, e.clientY);
    
    // Throttled cursor update
    socket.emit("cursor", {
      clientId: socket.id,
      x: e.clientX,
      y: e.clientY,
      color: brushColor,
      size: brushSize,
      isEraser: isEraser
    });
  }
  
  requestRedraw();
});

canvas.addEventListener("pointerup", (e) => {
  canvas.releasePointerCapture(e.pointerId);
  pointers.delete(e.pointerId);
  
  // Reset two-finger gesture when fingers are lifted
  if (pointers.size < 2) {
    isTwoFingerGesture = false;
    lastTwoFingerMid = null;
    
    // If was panning with two fingers, reset panning
    if (isPanning && pointers.size === 0) {
      isPanning = false;
    }
  }
  
  // End right-click panning
  if (e.button === 2) {
    isPanning = false;
    panStart = null;
    return;
  }
  
  // Finish stroke
  if (isDrawing && currentStroke && currentStroke.points.length >= 1) {
    const strokeCopy = { 
      points: currentStroke.points.slice(), 
      color: currentStroke.color, 
      size: currentStroke.size, 
      isEraser: currentStroke.isEraser,
      clientId: socket.id
    };
    
    console.log("✅ Завершение штриха:", {
      type: strokeCopy.isEraser ? "ЛАСТИК ✏️" : "КИСТЬ 🖌️",
      isEraser: strokeCopy.isEraser,
      points: strokeCopy.points.length,
      size: strokeCopy.size,
      color: strokeCopy.color
    });
    
    // Add to local strokes with temporary ID
    strokes.push({ 
      strokeId: null,
      ...strokeCopy
    });
    
    requestRedraw();
    
    // Send to server
    socket.emit("stroke", strokeCopy, (ack) => {
      if (ack && ack.strokeId) {
        // Update local stroke with server ID
        for (let i = strokes.length - 1; i >= 0; i--) {
          if (strokes[i].strokeId === null && 
              strokes[i].clientId === socket.id &&
              strokes[i].points.length === strokeCopy.points.length) {
            strokes[i].strokeId = ack.strokeId;
            break;
          }
        }
      }
    });
    
    currentStroke = null;
    isDrawing = false;
  }
  
  // Reset if no pointers left
  if (pointers.size === 0) {
    isPanning = false;
    panStart = null;
    socket.emit("cursor_remove", { clientId: socket.id });
    lastPointerScreen = null;
    hideBrushCursor();
  }
  
  requestRedraw();
});

canvas.addEventListener("pointercancel", (e) => {
  pointers.delete(e.pointerId);
  
  if (pointers.size < 2) {
    isTwoFingerGesture = false;
    lastTwoFingerMid = null;
  }
  
  if (pointers.size === 0) {
    currentStroke = null;
    isDrawing = false;
    isPanning = false;
    socket.emit("cursor_remove", { clientId: socket.id });
    lastPointerScreen = null;
    hideBrushCursor();
    requestRedraw();
  }
});

/* ---------- Wheel zoom (centralized to cursor position) ---------- */
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const before = screenToWorld(sx, sy);
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
  offsetX = sx - before.x * scale;
  offsetY = sy - before.y * scale;
  requestRedraw();
}, { passive: false });

/* ---------- Zoom buttons (centralized to canvas center) ---------- */
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");

function zoomToCenter(factor) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const before = screenToWorld(cx, cy);
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
  offsetX = cx - before.x * scale;
  offsetY = cy - before.y * scale;
  requestRedraw();
}

if (zoomInBtn) {
  zoomInBtn.addEventListener("click", () => zoomToCenter(1.2));
}

if (zoomOutBtn) {
  zoomOutBtn.addEventListener("click", () => zoomToCenter(1 / 1.2));
}

// Initial tool state
updateToolButtons();
requestRedraw();