const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { DateTime } = require("luxon");
const VIDEOCHAT_URL = process.env.VIDEOCHAT_URL;

// ========================
// GET fechas de un curso
// ========================
router.get("/courses/:selectedCourseId/dates", async (req, res) => {
  const { selectedCourseId } = req.params;

  try {
    // Verificar que el curso existe
    const result = await db.execute("SELECT 1 FROM cursos WHERE id = ?", [
      selectedCourseId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Curso no existe" });
    }

    // Obtener fechas desde 2 semanas atrás
    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();

    const fechas = await db.execute(
      `SELECT
         f.id, 
         f.inicio, 
         f.final, 
         f.tipo_encuentro AS tipo,
         f.titulo, 
         f.link_mot AS join_link,
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
      inicio: fecha.inicio,
      final: fecha.final,
      titulo: fecha.titulo,
      tipo: fecha.tipo,
      join_link: fecha.join_link,
      recording_url: fecha.recording_url,
    }));

    return res.json(fechasFormateadas);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

// ========================
// POST nuevas fechas
// ========================
router.post("/courses/:selectedCourseId/dates", async (req, res) => {
  const { sessions = [] } = req.body;
  const { selectedCourseId } = req.params;

  // Validar token
  const token = req.headers.authorization?.split(" ")[1];
  let userPayload;
  try {
    userPayload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    // Verificar que el usuario sea admin del curso
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

    const results = [];
    const cacheRooms = new Map(); // cache interno para no repetir llamadas

    // Agrupar sesiones por fecha local
    const sessionsByDate = sessions.reduce((acc, s) => {
      const timezone = s.timezone || "America/Bogota";
      const localDate = DateTime.fromISO(s.inicio, { zone: timezone }).toISODate();
      if (!acc[localDate]) acc[localDate] = [];
      acc[localDate].push(s);
      return acc;
    }, {});

    // Procesar una vez por fecha
    for (const [localDate, daySessions] of Object.entries(sessionsByDate)) {
      const first = daySessions[0]; // usamos la primera sesión del día como referencia
      const { inicio, final, titulo = "Clase", type = "Clase en vivo", timezone = "America/Bogota" } = first;

      const startUTC = DateTime.fromISO(inicio, { zone: timezone }).toUTC();
      const endUTC = DateTime.fromISO(final, { zone: timezone }).toUTC();

      if (!startUTC.isValid || !endUTC.isValid || endUTC <= startUTC) {
        console.error("Fechas inválidas para:", { inicio, final });
        continue;
      }

      let room_id = null;
      let link_mot = null;

      // 1. Revisar cache
      if (cacheRooms.has(localDate)) {
        ({ room_id, link_mot } = cacheRooms.get(localDate));
      } else {
        // 2. Revisar DB
        const existingRoom = await db.execute(
          `SELECT room_id, link_mot FROM fechas 
           WHERE idCurso = ? AND fecha_date = ?`,
          [selectedCourseId, localDate]
        );

        if (existingRoom.rows.length > 0 && existingRoom.rows[0].room_id) {
          room_id = existingRoom.rows[0].room_id;
          link_mot = existingRoom.rows[0].link_mot;
        } else {
          // 3. Llamar al API solo si no existe
          try {
            const payload = {
              course_id: selectedCourseId,
              start_utc: startUTC.toISO(),
              end_utc: endUTC.toISO(),
              session_date: localDate,
            };

            const { data } = await axios.post(
              `${VIDEOCHAT_URL}/api/calls`,
              payload,
              { headers: { Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` } }
            );

            link_mot = data.link;
            room_id = data.room_id;
          } catch (err) {
            console.error("Error al generar sala:", err.message);
          }
        }

        cacheRooms.set(localDate, { room_id, link_mot });
      }

      // Guardar todas las sesiones de ese día en DB con el mismo room_id/link
      for (const s of daySessions) {
        const sStartUTC = DateTime.fromISO(s.inicio, { zone: s.timezone || "America/Bogota" }).toUTC();
        const sEndUTC = DateTime.fromISO(s.final, { zone: s.timezone || "America/Bogota" }).toUTC();

        try {
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
              sStartUTC.toISO(),
              sEndUTC.toISO(),
              s.type || "Clase en vivo",
              selectedCourseId,
              s.titulo || "Clase",
              link_mot,
              localDate,
              room_id,
            ]
          );
          results.push({ date: localDate, status: "success" });
        } catch (dbError) {
          console.error("Error en DB:", dbError.message);
          results.push({ date: localDate, status: "failed" });
        }
      }
    }

    return res.json({ results });
  } catch (err) {
    console.error("Error crítico:", err);
    return res.status(500).json({ error: "Error al procesar solicitud" });
  }
});

module.exports = router;
