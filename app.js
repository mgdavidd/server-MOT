const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cookieParser = require("cookie-parser");
const path = require("path");
const dotenv = require("dotenv");
const cors = require("cors")

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = ["http://localhost:5174","http://localhost:5173", "http://localhost:3001"];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("No permitido por CORS"));
    }
  },
  credentials: true,
}));


app.use(cookieParser());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(express.static(path.join(__dirname, "public")));


const routes = require("./routes");
app.use(routes);

require("./routes/socket")(io);

const { uploadDir } = require("./uploadConfig");
const fs = require("fs");

process.on("SIGINT", () => {
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
  process.exit();
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)
);
