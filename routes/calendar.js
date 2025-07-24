const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");

router.get("/courses/:selectedCourseId/dates", async (req, res) => {
  const { selectedCourseId } = req.params;

  const result = await db.execute("SELECT 1 FROM cursos WHERE id = ?", [selectedCourseId]);
  if (result.rows.length === 0) {
    return res.status(404).json({ message: "Curso no existe" });
  }

  const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();

  const fechas = await db.execute(
    `SELECT f.inicio, f.final, f.tipo_encuentro AS tipo, f.titulo, g.link AS recording_url
     FROM fechas f
     LEFT JOIN grabaciones g ON g.idFecha = f.id
     WHERE f.idCurso = ? AND f.final >= ?
     ORDER BY f.inicio ASC`,
    [selectedCourseId, limiteInferior]
  );
  return res.json(fechas.rows);
});

router.post("/courses/:selectedCourseId/dates", async (req, res) => {
  const { sessions = [] } = req.body;
  const { selectedCourseId } = req.params;

  if (!Array.isArray(sessions)) {
    return res.status(400).json({ error: "Formato inválido" });
  }

  try {
    if (sessions.length > 0) {
      const keepDates = sessions.map(s => `${s.date}T${s.start_time.split("T")[1]}`);
      await db.execute(
        `DELETE FROM fechas 
         WHERE idCurso = ? AND inicio NOT IN (${keepDates.map(() => "?").join(",")})`,
        [selectedCourseId, ...keepDates]
      );
    }

    // insertar o actualizar fechas
    for (const s of sessions) {
      const { date, type, start_time, end_time } = s;

      if (!date || !type || !start_time || !end_time) {
        return res.status(400).json({ error: "Datos incompletos" });
      }

      await db.execute(
        `INSERT INTO fechas (
          inicio, final, tipo_encuentro, idCurso
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(idCurso, inicio) DO UPDATE SET
          final = excluded.final,
          tipo_encuentro = excluded.tipo_encuentro`,
        [start_time, end_time, type, selectedCourseId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error guardando fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
