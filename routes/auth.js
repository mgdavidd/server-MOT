const express = require("express");
const router = express.Router();
const db = require("../db");
const { OAuth2Client } = require("google-auth-library");
const { google } = require("googleapis");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

const oAuth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

router.post("/login", async (req, res) => {
  const { userName, password } = req.body;
  try {
    const result = await db.execute(
      "SELECT * FROM usuarios WHERE (nombre = ? OR email = ? OR nombre_usuario = ?) AND contrasena = ?",
      [userName, userName, userName, password]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          nombre: user.nombre,
          role: user.rol,
        },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({ success: true, user, token });
    }
    res.status(401).json({ error: "Credenciales incorrectas" });
  } catch (err) {
    console.error("Error en login:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.post("/signup", async (req, res) => {
  const { userName, email, password, isAdmin } = req.body;

  if (!userName || !email || !password)
    return res.status(400).json({ error: "Faltan campos obligatorios" });

  try {
    const nameExist = await db.execute(
      "SELECT 1 FROM usuarios WHERE nombre = ?",
      [userName]
    );
    if (nameExist.rows.length > 0)
      return res.status(409).json({ error: "Nombre de usuario ya existe" });

    const emailExist = await db.execute(
      "SELECT 1 FROM usuarios WHERE email = ?",
      [email]
    );
    if (emailExist.rows.length > 0)
      return res.status(409).json({ error: "Correo ya registrado" });

    await db.execute(
      "INSERT INTO usuarios (nombre, email, contrasena, rol) VALUES (?, ?, ?, ?)",
      [userName, email, password, isAdmin ? "profesor" : "estudiante"]
    );

    const result = await db.execute("SELECT * FROM usuarios WHERE nombre = ?", [
      userName,
    ]);
    const user = result.rows[0];
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.rol,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({ success: true, user, token });
  } catch (err) {
    console.error("Error en registro:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.post("/choose-username", async (req, res) => {
  const { userName, password, email, google_token } = req.body;

  if (!userName || !password || !email || !google_token) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const exists = await db.execute("SELECT 1 FROM usuarios WHERE nombre = ?", [
      userName,
    ]);
    if (exists.rows.length) {
      return res.status(409).json({ error: "Nombre de usuario ya existe" });
    }

    await db.execute(
      "INSERT INTO usuarios (nombre, contrasena, email, rol, google_token) VALUES (?, ?, ?, 'estudiante', ?)",
      [userName, password, email, JSON.stringify(google_token)]
    );

    const result = await db.execute("SELECT * FROM usuarios WHERE nombre = ?", [
      userName,
    ]);

    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Error creando usuario:", err);
    res.status(500).json({ error: "Error interno al registrar con Google" });
  }
});

router.get("/auth/google", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.metadata",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    prompt: "consent",
  });
  res.redirect(authUrl);
});

router.get("/auth/google/callback", async (req, res) => {
  try {
    const { tokens } = await oAuth2Client.getToken(req.query.code);
    oAuth2Client.setCredentials(tokens);

    const people = google.people({ version: "v1", auth: oAuth2Client });
    const { data } = await people.people.get({
      resourceName: "people/me",
      personFields: "emailAddresses",
    });

    const userEmail = data.emailAddresses?.[0]?.value?.toLowerCase();
    if (!userEmail) throw new Error("Email no disponible");

    const userResult = await db.execute(
      "SELECT * FROM usuarios WHERE LOWER(email) = ?",
      [userEmail]
    );

    if (userResult.rows.length) {
      await db.execute(
        "UPDATE usuarios SET google_token = ? WHERE LOWER(email) = ?",
        [JSON.stringify(tokens), userEmail]
      );

      const user = userResult.rows[0];
      // 👉 Enviamos el usuario en la URL (en URI encoded JSON)
      return res.redirect(
        `http://localhost:5173/oauth-success?user=${encodeURIComponent(
          JSON.stringify(user)
        )}`
      );
    }

    return res.redirect(
      `http://localhost:5173/choose-username?email=${encodeURIComponent(
        userEmail
      )}&google_token=${encodeURIComponent(JSON.stringify(tokens))}`
    );
  } catch (err) {
    console.error("Error en Google Auth:", err);
    res.redirect("http://localhost:5173?error=auth");
  }
});

router.post("/updateArea", async (req, res) => {
  await db.execute("UPDATE usuarios SET area = ? WHERE nombre = ?", [
    req.body.area,
    req.body.userName,
  ]);
  res.status(202);
});

router.get("/user/:id", async (req, res) => {
  const result = await db.execute("SELECT * FROM usuarios WHERE id = ? ", [
    req.params.id,
  ]);

  if (result.rows.length > 0) {
    console.log(result);
    return res.send(result);
  }
  return res.send(result.rows);
});

router.post("/isUserAllowed", async (req, res) => {
  const apiKey = req.headers.authorization?.split(" ")[1];

  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const { userId, courseId } = req.body;
  const result = await db.execute(
    `SELECT 1 FROM cursos_estudiante WHERE idUsuario = ? AND idCurso = ?`,
    [userId, courseId]
  );

  const isTeacher = await db.execute(
    `SELECT 1 FROM cursos WHERE id = ? AND admin = ?`,
    [courseId, userId]
  );

  if (result.rows.length > 0 || isTeacher.rows.length > 0) {
    return res.json({ allowed: true });
  }

  return res.json({ allowed: false });
});

module.exports = router;
