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

// Configuración CORS mejorada - INCLUIR methods y allowedHeaders aquí también
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      "http://localhost:5173",
      "https://front-mot.onrender.com", 
      "https://videochat-webrtc.onrender.com"
    ];
    
    // Log para debug
    console.log("🔍 CORS check - Origin:", origin);
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log("❌ CORS rechazado para origin:", origin);
      callback(new Error("No permitido por CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"], // ← IMPORTANTE: Añadir aquí
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"] // ← IMPORTANTE: Añadir aquí
}));

// Manejar preflight OPTIONS para todas las rutas - Simplificado
app.options("*", (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    "http://localhost:5173",
    "https://front-mot.onrender.com",
    "https://videochat-webrtc.onrender.com"
  ];

  console.log("🔧 OPTIONS request from:", origin);

  if (!origin || allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With,Accept,Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.status(200).send();
  } else {
    console.log("❌ OPTIONS rechazado para:", origin);
    res.status(403).send("CORS: Origin not allowed");
  }
});

// Middleware de logging para debug
app.use((req, res, next) => {
  if (req.path.includes('/courses/') && req.path.includes('/dates')) {
    console.log(`🎯 Calendar API: ${req.method} ${req.path}`, {
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
      authorization: req.headers.authorization ? 'Present' : 'Missing'
    });
  }
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(express.static(path.join(__dirname, "public")));

const routes = require("./routes");
app.use(routes);

const setupSocket = require("./routes/socket");
const io = setupSocket(server);

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
server.listen(PORT, () => {
  console.log(`🚀 MOT Server corriendo en http://localhost:${PORT}`);
  console.log(`🌐 CORS habilitado para: front-mot.onrender.com`);
});