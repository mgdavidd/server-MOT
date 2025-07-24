const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");

// 
router.get("/teachers/:userId/courses", async (req, res) => {
  const userId = req.params.userId;
  const result = await db.execute("SELECT * FROM cursos WHERE admin = ?", [userId]);

  const cursos = result.rows.map(curso => ({
    ...curso,
    isOwner: true
  }));

  return res.send(cursos);
});

router.post("/create-course", async (req, res) => {
  const {
    nombre,
    costo,
    descripcion,
    admin,
    tipoCurso,
    area,
    imagen,
  } = req.body;

  // Validar campos requeridos
  if (!nombre || !admin || !tipoCurso || !area || !imagen) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }

  try {
    const usuario = await db.execute(
      "SELECT * FROM usuarios WHERE id = ? AND rol = 'profesor'",
      [admin]
    );

    if (usuario.rows.length === 0) {
      return res.json({ error: "Solo los profesores pueden crear cursos" });
    }

    const cursoExistente = await db.execute(
      "SELECT * FROM cursos WHERE nombre = ? AND admin = ?",
      [nombre, admin]
    );

    if (cursoExistente.rows.length > 0) {
      return res.json({ error: "Ya existe un curso con ese nombre para este profesor" });
    }
    //fecha en utc
    const fechaActual = DateTime.utc().toISO();

    await db.execute(
      `INSERT INTO cursos (nombre, fecha, precio, descripcion, admin, tipoCurso, genero, portada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nombre,fechaActual, costo || null, descripcion || null, admin, tipoCurso, area, imagen]
    );

    return res.status(201).json({ success: true, message: "Curso creado exitosamente" });

  } catch (error) {
    console.error("Error al crear el curso:", error);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;