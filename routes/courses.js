const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");

router.get("/my-courses/:userEmail", async (req, res) => {
  const result = await db.execute(
    "SELECT c.id, c.nombre, c.tipoCurso, c.genero FROM cursos c JOIN usuarios u ON  u.id = c.admin WHERE u.email = ?",
    [req.params.userEmail]
  )

  if(result.rows.length > 0){
    console.log(result)
    return res.send( result)
  }
  return res.send(result.rows)
})

router.post("/create-course", async (req, res) => {
  const {
    nombre,
    precio,
    descripcion,
    admin,
    tipoCurso,
    genero
  } = req.body;

  // Validar campos requeridos
  if (!nombre || !admin || !tipoCurso || !genero) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }

  try {
    const usuario = await db.execute(
      "SELECT * FROM usuarios WHERE id = ? AND rol = 'profesor'",
      [admin]
    );

    if (usuario.rows.length === 0) {
      return res.status(403).json({ error: "Solo los profesores pueden crear cursos" });
    }

    const cursoExistente = await db.execute(
      "SELECT * FROM cursos WHERE nombre = ? AND admin = ?",
      [nombre, admin]
    );

    if (cursoExistente.rows.length > 0) {
      return res.status(409).json({ error: "Ya existe un curso con ese nombre para este profesor" });
    }

    const fechaActual = DateTime.now().toISO({ suppressMilliseconds: true });

    await db.execute(
      `INSERT INTO cursos (nombre, fecha, precio, descripcion, admin, tipoCurso, genero)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nombre,fechaActual, precio || null, descripcion || null, admin, tipoCurso,genero]
    );

    return res.status(201).json({ success: true, message: "Curso creado exitosamente" });

  } catch (error) {
    console.error("Error al crear el curso:", error);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;