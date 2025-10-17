const socket = io();
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const colorPicker = document.getElementById("colorPicker");
const brushSize = document.getElementById("brushSize");
const toggleGrid = document.getElementById("toggleGrid");
const tools = document.querySelectorAll(".tool");

const WIDTH = 10000;
const HEIGHT = 10000;
let scale = 1;
let offsetX = 0;
let offsetY = 0;

let drawing = false;
let isPanning = false;
let startPan = { x: 0, y: 0 };
let showGrid = true;
let currentTool = "brush";

const pixels = new Map();


tools.forEach(btn => {
  btn.addEventListener("click", () => {
    tools.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentTool = btn.id;
  });
});

toggleGrid.addEventListener("change", () => {
  showGrid = toggleGrid.checked;
  redraw();
});


function screenToCanvas(x, y) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.floor((x - rect.left - offsetX) / scale),
    y: Math.floor((y - rect.top - offsetY) / scale),
  };
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button === 2) {
    isPanning = true;
    startPan = { x: e.clientX - offsetX, y: e.clientY - offsetY };
  } else if (e.button === 0) {
    drawing = true;
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    drawAndSend(x, y);
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (isPanning) {
    offsetX = e.clientX - startPan.x;
    offsetY = e.clientY - startPan.y;
    redraw();
  } else if (drawing) {
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    drawAndSend(x, y);
  }
});

canvas.addEventListener("mouseup", () => {
  drawing = false;
  isPanning = false;
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());


canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  scale *= factor;
  scale = Math.max(0.5, Math.min(40, scale));
  redraw();
});

canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    drawing = true;
    const touch = e.touches[0];
    const { x, y } = screenToCanvas(touch.clientX, touch.clientY);
    drawAndSend(x, y);
  } else if (e.touches.length === 2) {
    isPanning = true;
    const t1 = e.touches[0], t2 = e.touches[1];
    startPan = { x: (t1.clientX + t2.clientX) / 2 - offsetX, y: (t1.clientY + t2.clientY) / 2 - offsetY };
  }
});

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (drawing && e.touches.length === 1) {
    const touch = e.touches[0];
    const { x, y } = screenToCanvas(touch.clientX, touch.clientY);
    drawAndSend(x, y);
  } else if (isPanning && e.touches.length === 2) {
    const t1 = e.touches[0], t2 = e.touches[1];
    offsetX = (t1.clientX + t2.clientX) / 2 - startPan.x;
    offsetY = (t1.clientY + t2.clientY) / 2 - startPan.y;
    redraw();
  }
}, { passive: false });

canvas.addEventListener("touchend", () => {
  drawing = false;
  isPanning = false;
});

function drawAndSend(x, y) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const size = parseInt(brushSize.value);
  const color = currentTool === "eraser" ? "#ffffff" : colorPicker.value;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);

  for (let dx = 0; dx < size; dx++) {
    for (let dy = 0; dy < size; dy++) {
      const key = `${x + dx},${y + dy}`;
      pixels.set(key, color);
      socket.emit("drawPixel", { x: x + dx, y: y + dy, color });
    }
  }
}

function redraw() {
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  ctx.clearRect(-offsetX / scale, -offsetY / scale, WIDTH, HEIGHT);

  for (let [key, color] of pixels.entries()) {
    const [x, y] = key.split(",").map(Number);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  }

  if (showGrid && scale > 5) {
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.beginPath();
    for (let i = 0; i <= WIDTH; i++) {
      ctx.moveTo(i, 0);
      ctx.lineTo(i, HEIGHT);
    }
    for (let j = 0; j <= HEIGHT; j++) {
      ctx.moveTo(0, j);
      ctx.lineTo(WIDTH, j);
    }
    ctx.stroke();
  }
}
socket.on("init", (data) => {
  data.forEach(([key, color]) => {
    pixels.set(key, color);
    const [x, y] = key.split(",").map(Number);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  });
});

socket.on("drawPixel", ({ x, y, color }) => {
  pixels.set(`${x},${y}`, color);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
});

const menuToggle = document.getElementById("menuToggle");
const sidebar = document.getElementById("sidebar");

menuToggle.addEventListener("click", () => {
  sidebar.classList.toggle("open");
});

