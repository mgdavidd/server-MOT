const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { DateTime } = require("luxon");

// Cache en memoria
const roomCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 minuto

async function validateUserCourseAccess(userId, courseId) {
  try {
    const result = await db.execute(
      `SELECT 1 FROM cursos_estudiante WHERE idUsuario = ? AND idCurso = ? 
       UNION 
       SELECT 1 FROM cursos WHERE id = ? AND admin = ?`,
      [userId, courseId, courseId, userId]
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error("Error validando acceso al curso:", err);
    return false;
  }
}

// ================================
// 📌 GET fechas del curso
// ================================
router.get("/courses/:selectedCourseId/dates", async (req, res) => {
  const { selectedCourseId } = req.params;

  try {
    const result = await db.execute("SELECT 1 FROM cursos WHERE id = ?", [
      selectedCourseId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Curso no existe" });
    }

    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();

    const fechas = await db.execute(
      `SELECT
         f.id, 
         f.inicio, 
         f.final, 
         f.tipo_encuentro AS tipo,
         f.titulo, 
         f.link_mot,
         g.link AS recording_url,
         f.room_id
       FROM fechas f
       LEFT JOIN grabaciones g ON g.idFecha = f.id
       WHERE f.idCurso = ? AND f.final >= ?
       ORDER BY f.inicio ASC`,
      [selectedCourseId, limiteInferior]
    );

    const fechasFormateadas = fechas.rows.map((fecha) => ({
      ...fecha,
      join_link: fecha.room_id
        ? `/courses/${selectedCourseId}/join/${fecha.room_id}` // 🔹 proxy seguro
        : null,
    }));

    return res.json(fechasFormateadas);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

// ================================
// 📌 Proxy de acceso seguro
// ================================
router.get("/courses/:courseId/join/:roomId", async (req, res) => {
  const { courseId, roomId } = req.params;

  const token =
    req.query.auth ||
    req.headers.authorization?.split(" ")[1] ||
    req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: "Token requerido" });
  }

  try {
    const userPayload = jwt.verify(token, JWT_SECRET);
    const hasAccess = await validateUserCourseAccess(userPayload.id, courseId);
    if (!hasAccess) {
      return res.status(403).json({ error: "Sin acceso al curso" });
    }

    const roomResult = await db.execute(
      `SELECT room_id, link_mot FROM fechas WHERE room_id = ? AND idCurso = ?`,
      [roomId, courseId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: "Sala no encontrada" });
    }

    const roomData = roomResult.rows[0];
    let roomToken;
    try {
      const urlParts = roomData.link_mot?.split("?");
      if (urlParts?.length > 1) {
        const urlParams = new URLSearchParams(urlParts[1]);
        roomToken = urlParams.get("token");
      }
    } catch (_) {}

    if (!roomToken) {
      roomToken = jwt.sign({ room_id: roomId, course_id: courseId }, JWT_SECRET);
    }

    const redirectUrl = `${process.env.VIDEOCHAT_URL}/join?token=${roomToken}&user_token=${encodeURIComponent(
      token
    )}`;
    return res.redirect(redirectUrl);
  } catch (err) {
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Token inválido" });
    }
    console.error("Error en proxy:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ================================
// 📌 Crear/actualizar fechas
// ================================
router.post("/courses/:selectedCourseId/dates", async (req, res) => {
  const { sessions = [] } = req.body;
  const { selectedCourseId } = req.params;

  const token = req.headers.authorization?.split(" ")[1];
  let userPayload;
  try {
    userPayload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    const isOwner =
      (
        await db.execute(
          `SELECT id FROM cursos WHERE id = ? AND admin = ?`,
          [selectedCourseId, userPayload.id]
        )
      ).rows.length > 0;

    if (!isOwner) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const validSessions = sessions.filter((s) => {
      const startUTC = DateTime.fromISO(s.inicio, {
        zone: s.timezone || "America/Bogota",
      }).toUTC();
      const endUTC = DateTime.fromISO(s.final, {
        zone: s.timezone || "America/Bogota",
      }).toUTC();
      return startUTC.isValid && endUTC.isValid && endUTC > startUTC;
    });

    // 🔹 Mandamos todas las sesiones en un solo request al servidor de videollamadas
    const { VIDEOCHAT_URL } = process.env;
    const { data } = await axios.post(
      `${VIDEOCHAT_URL}/api/calls`,
      {
        course_id: selectedCourseId,
        sessions: validSessions,
      },
      { headers: { Authorization: `Bearer ${jwt.sign({ course_id: selectedCourseId }, JWT_SECRET)}` } }
    );

    // 🔹 Guardamos en DB todas las salas recibidas
    for (const session of data.results) {
      const { inicio, final, titulo, type, timezone, room_id, link } = session;
      const startUTC = DateTime.fromISO(inicio, { zone: timezone }).toUTC();
      const endUTC = DateTime.fromISO(final, { zone: timezone }).toUTC();
      const localDate = DateTime.fromISO(inicio, { zone: timezone }).toISODate();

      await db.execute(
        `INSERT INTO fechas (
          inicio, final, tipo_encuentro, idCurso, titulo, link_mot, fecha_date, room_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idCurso, fecha_date) DO UPDATE SET
          inicio = excluded.inicio,
          final = excluded.final,
          titulo = excluded.titulo,
          tipo_encuentro = excluded.tipo_encuentro,
          link_mot = COALESCE(excluded.link_mot, fechas.link_mot),
          room_id = COALESCE(excluded.room_id, fechas.room_id)`,
        [
          startUTC.toISO(),
          endUTC.toISO(),
          type,
          selectedCourseId,
          titulo,
          link, // 🔹 guardamos link real del videochat
          localDate,
          room_id,
        ]
      );
    }

    return res.json({ results: data.results });
  } catch (err) {
    console.error("Error crítico:", err);
    return res.status(500).json({ error: "Error al procesar solicitud" });
  }
});

// Limpieza del cache
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of roomCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      roomCache.delete(key);
    }
  }
}, CACHE_TTL);

module.exports = router;
