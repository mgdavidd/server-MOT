const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { DateTime } = require("luxon");

// GET fechas
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
         f.id, f.inicio, f.final, f.tipo_encuentro AS tipo,
         f.titulo, f.link_mot AS join_link,
         g.link AS recording_url
       FROM fechas f
       LEFT JOIN grabaciones g ON g.idFecha = f.id
       WHERE f.idCurso = ? AND f.final >= ?
       ORDER BY f.inicio ASC`,
      [selectedCourseId, limiteInferior]
    );

    const fechasConZonaHoraria = fechas.rows.map((fecha) => ({
      ...fecha,
      inicio: DateTime.fromISO(fecha.inicio, { zone: "utc" }).toLocal().toISO(),
      final: DateTime.fromISO(fecha.final, { zone: "utc" }).toLocal().toISO(),
      titulo: fecha.titulo,
      tipo: fecha.tipo,
      join_link: fecha.join_link,
      recording_url: fecha.recording_url,
    }));

    return res.json(fechasConZonaHoraria);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

// POST fechas
router.post("/courses/:selectedCourseId/dates", async (req, res) => {
  const { sessions = [] } = req.body;
  const { selectedCourseId } = req.params;

  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  let userPayload;
  try {
    userPayload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    // Verificar propiedad del curso
    const courseOwnership = await db.execute(
      `SELECT id FROM cursos WHERE id = ? AND admin = ?`,
      [selectedCourseId, userPayload.id]
    );

    if (courseOwnership.rows.length === 0) {
      return res
        .status(403)
        .json({ error: "No tienes permiso para modificar este curso" });
    }

    if (!Array.isArray(sessions)) {
      return res.status(400).json({ error: "Formato inválido" });
    }

    // Obtener fechas existentes
    const fechasExistentes = await db.execute(
      `SELECT id, fecha_date FROM fechas WHERE idCurso = ?`,
      [selectedCourseId]
    );

    const fechasAMantener = sessions.map((s) => s.date);

    const idsAEliminar = fechasExistentes.rows
      .filter((row) => !fechasAMantener.includes(row.fecha_date))
      .map((row) => row.id);

    if (idsAEliminar.length > 0) {
      const placeholders = idsAEliminar.map(() => "?").join(",");
      await db.execute(
        `DELETE FROM fechas WHERE id IN (${placeholders})`,
        idsAEliminar
      );
    }

    // Procesar sesiones
    for (const s of sessions) {
      const {
        date,
        start_time,
        end_time,
        titulo = "Clase",
        type = "Clase en vivo",
      } = s;

      if (!date || !start_time || !end_time) continue;

      // Convertir de local a UTC antes de guardar
      const inicioLocal = DateTime.fromISO(`${date}T${start_time}`).toLocal();
      const finalLocal = DateTime.fromISO(`${date}T${end_time}`).toLocal();

      const inicioISO = inicioLocal.toUTC().toISO();
      const finalISO = finalLocal.toUTC().toISO();

      let link_mot = null;

      try {
        const VIDEOCHAT_URL =
          process.env.VIDEOCHAT_API || "http://localhost:3001";
        const inicioUTC = DateTime.fromISO(inicioISO).toUTC().toFormat("HH:mm");
        const finalUTC = DateTime.fromISO(finalISO).toUTC().toFormat("HH:mm");

        const payload = {
          course_id: selectedCourseId,
          session_date: date,
          start_time: inicioUTC,
          end_time: finalUTC,
          email: userPayload.email,
          role: userPayload.role,
          user_id: userPayload.id,
          title: titulo,
        };

        const tokenMOT = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });

        const resp = await Promise.race([
          axios.post(`${VIDEOCHAT_URL}/api/calls`, payload, {
            headers: { Authorization: `Bearer ${tokenMOT}` },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout de video")), 3000)
          ),
        ]);

        link_mot = resp.data.link;
      } catch (err) {
        console.error("Error generando link:", err.message);
      }

      try {
        await db.execute(
          `INSERT INTO fechas (
             inicio, final, tipo_encuentro, idCurso, titulo, link_mot, fecha_date
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(idCurso, fecha_date) DO UPDATE SET
             inicio = excluded.inicio,
             final = excluded.final,
             tipo_encuentro = excluded.tipo_encuentro,
             titulo = excluded.titulo,
             link_mot = COALESCE(excluded.link_mot, fechas.link_mot)`,
          [inicioISO, finalISO, type, selectedCourseId, titulo, link_mot, date]
        );
      } catch (dbError) {
        console.error("Error en DB:", dbError.message);

        await db.execute(
          `UPDATE fechas SET
             inicio = ?,
             final = ?,
             tipo_encuentro = ?,
             titulo = ?,
             link_mot = COALESCE(?, link_mot)
           WHERE idCurso = ? AND fecha_date = ?`,
          [inicioISO, finalISO, type, titulo, link_mot, selectedCourseId, date]
        );
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error en calendar.js:", {
      message: err.message,
      stack: err.stack,
      body: req.body,
      params: req.params,
    });
    return res.status(500).json({
      error: "Error al guardar el calendario",
      details: process.env.NODE_ENV === "development" ? err.message : null,
    });
  }
});

module.exports = router;
