const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/modulos/:idModulo/foros", async (req, res) => {
  try {
    const { idModulo } = req.params;
    const result = await db.execute(
      `SELECT f.*, u.nombre AS autor, u.fotoPerfil 
       FROM foros f
       JOIN usuarios u ON u.id = f.idUsuario
       WHERE f.idModulo = ?
       ORDER BY f.fechaCreacion DESC`,
      [idModulo]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.post("/foros", async (req, res) => {
  const { idModulo, idUsuario, tipoReferencia, idReferencia, titulo, mensaje } = req.body;
  if (!idModulo || !idUsuario || !tipoReferencia || !titulo || !mensaje) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  try {
    await db.execute(
      `INSERT INTO foros (idModulo, idUsuario, tipoReferencia, idReferencia, titulo, mensaje)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [idModulo, idUsuario, tipoReferencia, idReferencia || null, titulo, mensaje]
    );
    res.status(201).json({ success: true, message: "Foro creado exitosamente" });
  } catch (error) {
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.get("/foros/:idForo", async (req, res) => {
  try {
    const { idForo } = req.params;
    const foro = await db.execute(
      `SELECT f.*, u.nombre AS autor, u.fotoPerfil
       FROM foros f
       JOIN usuarios u ON u.id = f.idUsuario
       WHERE f.id = ?`,
      [idForo]
    );
    if (foro.rows.length === 0) {
      return res.status(404).json({ error: "Foro no encontrado" });
    }
    const respuestas = await db.execute(
      `SELECT r.*, u.nombre AS autor, u.fotoPerfil
       FROM respuestasForo r
       JOIN usuarios u ON u.id = r.idUsuario
       WHERE r.idForo = ?
       ORDER BY r.fechaCreacion ASC`,
      [idForo]
    );
    res.json({ ...foro.rows[0], respuestas: respuestas.rows });
  } catch (error) {
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.delete("/foros/:idForo", async (req, res) => {
  try {
    const { idForo } = req.params;
    await db.execute("DELETE FROM foros WHERE id = ?", [idForo]);
    res.json({ success: true, message: "Foro eliminado correctamente" });
  } catch (error) {
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.post("/foros/:idForo/respuestas", async (req, res) => {
  const { idForo } = req.params;
  const { idUsuario, mensaje } = req.body;
  if (!idUsuario || !mensaje) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  try {
    await db.execute(
      `INSERT INTO respuestasForo (idForo, idUsuario, mensaje)
       VALUES (?, ?, ?)`,
      [idForo, idUsuario, mensaje]
    );
    res.status(201).json({ success: true, message: "Respuesta creada exitosamente" });
  } catch (error) {
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.delete("/respuestas/:idRespuesta", async (req, res) => {
  try {
    const { idRespuesta } = req.params;
    await db.execute("DELETE FROM respuestasForo WHERE id = ?", [idRespuesta]);
    res.json({ success: true, message: "Respuesta eliminada correctamente" });
  } catch (error) {
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
