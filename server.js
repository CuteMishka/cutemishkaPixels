import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = 3000;

// Размер холста
const WIDTH = 1000;
const HEIGHT = 1000;

// Храним закрашенные пиксели
// Ключ: "x,y" → значение: "#RRGGBB"
const pixels = new Map();

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("🟢 Новый пользователь подключился:", socket.id);

  // Отправляем уже существующие пиксели новому пользователю
  socket.emit("init", Array.from(pixels.entries()));

  // Когда кто-то рисует
  socket.on("drawPixel", (data) => {
    const key = `${data.x},${data.y}`;
    pixels.set(key, data.color);

    // Рассылаем другим
    socket.broadcast.emit("drawPixel", data);
  });

  // Очистка холста
  socket.on("clearCanvas", () => {
    pixels.clear();
    io.emit("clearCanvas");
  });

  socket.on("disconnect", () => {
    console.log("🔴 Пользователь отключился:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});
