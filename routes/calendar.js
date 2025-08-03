const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { DateTime } = require("luxon");

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
         g.link AS recording_url
       FROM fechas f
       LEFT JOIN grabaciones g ON g.idFecha = f.id
       WHERE f.idCurso = ? AND f.final >= ?
       ORDER BY f.inicio ASC`,
      [selectedCourseId, limiteInferior]
    );

    // Devolver las fechas exactamente como están en la base de datos (UTC)
    const fechasFormateadas = fechas.rows.map((fecha) => ({
      ...fecha,
      inicio: fecha.inicio, // Mantener UTC
      final: fecha.final,   // Mantener UTC
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

router.post("/courses/:selectedCourseId/dates", async (req, res) => {
  const { sessions = [] } = req.body;
  const { selectedCourseId } = req.params;
  const todayUTC = DateTime.now().setZone('UTC').startOf('day');

  // Verificación de token
  const token = req.headers.authorization?.split(" ")[1];
  let userPayload;
  try {
    userPayload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    const isOwner = (await db.execute(
      `SELECT id FROM cursos WHERE id = ? AND admin = ?`,
      [selectedCourseId, userPayload.id]
    )).rows.length > 0;

    if (!isOwner) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const results = [];
    for (const s of sessions) {
      const { date, start_time, end_time, titulo = "Clase", type = "Clase en vivo" } = s;
      
      if (!date || !start_time || !end_time) {
        console.error("Campos faltantes:", { date, start_time, end_time });
        continue;
      }

      if (!/^\d{2}:\d{2}$/.test(start_time) || !/^\d{2}:\d{2}$/.test(end_time)) {
        console.error("Formato de hora inválido:", { start_time, end_time });
        continue;
      }

      const dateUTC = DateTime.fromISO(date, { zone: 'utc' }).startOf('day');
      const startUTC = DateTime.fromISO(`${date}T${start_time}`, { zone: 'utc' });
      const endUTC = DateTime.fromISO(`${date}T${end_time}`, { zone: 'utc' });


      if (endUTC <= startUTC) {
        console.error(`Hora final debe ser mayor a hora inicial (${start_time} - ${end_time})`);
        continue;
      }

      // Generar link de videochat
      let link_mot = null;
      if (type === "Clase en vivo") {
        try {
          const VIDEOCHAT_URL = process.env.VIDEOCHAT_API || "http://localhost:3001";
          const payload = {
            course_id: selectedCourseId,
            session_date: date,
            start_time,
            end_time,
            user_id: userPayload.id
          };

          const { data } = await axios.post(
            `${VIDEOCHAT_URL}/api/calls`,
            payload,
            { headers: { Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` } }
          );
          link_mot = data.link;
        } catch (err) {
          console.error("Error al generar sala:", err.message);
        }
      }

      try {
        await db.execute(
          `INSERT INTO fechas (
            inicio, final, tipo_encuentro, idCurso, titulo, link_mot, fecha_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(idCurso, fecha_date) DO UPDATE SET
            inicio = excluded.inicio,
            final = excluded.final,
            titulo = excluded.titulo,
            link_mot = COALESCE(excluded.link_mot, fechas.link_mot)`,
          [
            startUTC.toISO(), 
            endUTC.toISO(), 
            type, 
            selectedCourseId, 
            titulo, 
            link_mot, 
            date
          ]
        );
        results.push({ date, status: "success" });
      } catch (dbError) {
        console.error("Error en DB:", dbError.message);
        results.push({ date, status: "failed" });
      }
    }

    return res.json({ results });
  } catch (err) {
    console.error("Error crítico:", err);
    return res.status(500).json({ error: "Error al procesar solicitud" });
  }
});

module.exports = router;