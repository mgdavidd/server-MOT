const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");
const { DateTime } = require("luxon");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const VIDEOCHAT_URL = process.env.VIDEOCHAT_URL || "https://videochat-webrtc.onrender.com";

// ================================
// 📌 RUTA: POST /courses/:id/dates
// ================================
router.post("/courses/:id/dates", async (req, res) => {
  const { id: selectedCourseId } = req.params;
  const { sessions } = req.body;

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return res.status(400).json({ error: "No hay sesiones para procesar" });
  }

  try {
    // Normalizar sesiones a UTC + extraer fecha local
    const normalized = sessions.map((s) => {
      const tz = s.timezone || "America/Bogota";
      const startUTC = DateTime.fromISO(s.inicio, { zone: tz }).toUTC();
      const endUTC = DateTime.fromISO(s.final, { zone: tz }).toUTC();
      const localDate = DateTime.fromISO(s.inicio, { zone: tz }).toISODate();

      return {
        ...s,
        startUTC,
        endUTC,
        localDate,
      };
    });

    // Detectar fechas únicas
    const distinctDates = [...new Set(normalized.map((n) => n.localDate))];
    const placeholders = distinctDates.map(() => "?").join(",");

    // Buscar en nuestra tabla local `fechas`
    const existingQuery = await db.execute(
      `SELECT room_id, fecha_date as session_date 
       FROM fechas 
       WHERE idCurso = ? AND fecha_date IN (${placeholders})`,
      [selectedCourseId, ...distinctDates]
    );

    const existingMap = new Map();
    for (const row of existingQuery.rows) {
      if (row.room_id) {
        existingMap.set(row.session_date, row.room_id);
      }
    }

    // Adjuntar room_id si ya existía
    const validSessions = normalized.map((s) => ({
      inicio: s.startUTC.toISO(),
      final: s.endUTC.toISO(),
      titulo: s.titulo,
      type: s.type,
      timezone: s.timezone,
      localDate: s.localDate,
      room_id: existingMap.get(s.localDate) || null,
    }));

    // Firmar token para llamar al servicio de videochat
    const serviceToken = jwt.sign({ course_id: selectedCourseId }, JWT_SECRET);

    // Enviar un único request batch al servidor de videollamadas
    const { data } = await axios.post(
      `${VIDEOCHAT_URL}/api/calls`,
      { course_id: selectedCourseId, sessions: validSessions },
      { headers: { Authorization: `Bearer ${serviceToken}` } }
    );

    // Guardar/actualizar en nuestra DB `fechas`
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
          link,
          localDate,
          room_id,
        ]
      );
    }

    return res.json({ message: "Sesiones actualizadas", results: data.results });
  } catch (err) {
    console.error("Error crítico en /courses/:id/dates:", err);
    return res.status(500).json({ error: "Error interno procesando fechas" });
  }
});

// ================================
// 📌 RUTA: GET /courses/:id/dates
// ================================
router.get("/courses/:id/dates", async (req, res) => {
  const { id: selectedCourseId } = req.params;

  try {
    const result = await db.execute(
      `SELECT * FROM fechas WHERE idCurso = ? ORDER BY inicio ASC`,
      [selectedCourseId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("Error crítico en GET /courses/:id/dates:", err);
    return res.status(500).json({ error: "Error al obtener fechas" });
  }
});

module.exports = router;
