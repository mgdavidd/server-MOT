const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");

router.get("/calendar-form/:courseId", async (req, res) => {
  const { courseId } = req.params;
  const { userName } = req.cookies;

  const result = await db.execute("SELECT 1 FROM cursos WHERE id = ?", [courseId]);
  const owner = await db.execute(
    "SELECT 1 FROM rooms r JOIN users u ON r.admin = u.id WHERE u.nombre = ? AND r.id = ?",
    [userName, courseId]
  );

  const isOwner = owner.rows.length > 0;
  if (result.rows.length > 0) {
    return res.render("calendar", { courseId, isOwner });
  } else {
    return res.status(404).render("error-calendar", {message: "La sala no existe"});
  }
});

router.post("/fechas", async (req, res) => {
  const { fechas = [], selectedDates = [], roomId = "1" } = req.body;

  if (!Array.isArray(fechas)) {
    return res.status(400).json({ error: "Formato inválido" });
  }

  try {
    if (selectedDates.length > 0) {
      await db.execute(
        `DELETE FROM fechas 
         WHERE roomId = ? AND fecha_local NOT IN (${selectedDates
           .map(() => "?")
           .join(",")})`,
        [roomId, ...selectedDates]
      );
    }

    for (const f of fechas) {
      const { date, start, end, type, timeZone } = f;

      if (!date || !start || !end || !timeZone) {
        return res.status(400).json({ error: "Datos incompletos" });
      }

      const startUTC = DateTime.fromISO(`${date}T${start}`, { zone: timeZone })
        .toUTC()
        .toISO();
      const endUTC = DateTime.fromISO(`${date}T${end}`, { zone: timeZone })
        .toUTC()
        .toISO();

      await db.execute(
        `INSERT INTO fechas (
          fecha_inicial_utc, fecha_final_utc, tipo, roomId, fecha_local
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(roomId, fecha_local) DO UPDATE SET
          fecha_inicial_utc = excluded.fecha_inicial_utc,
          fecha_final_utc = excluded.fecha_final_utc,
          tipo = excluded.tipo`,
        [startUTC, endUTC, type, roomId, date]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error guardando fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.get("/fechas/:roomId", async (req, res) => {
  try {
    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();
    const result = await db.execute(
      `SELECT f.fecha_inicial_utc, f.fecha_final_utc, f.tipo, f.fecha_local, 
              g.direccion AS grabacion_url, g.titulo AS grabacion_titulo, g.es_publico
       FROM fechas f
       LEFT JOIN grabaciones g ON g.fecha_id = f.id
       WHERE f.roomId = ? AND f.fecha_final_utc >= ?
       ORDER BY f.fecha_inicial_utc ASC`,
      [req.params.roomId, limiteInferior]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
