const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

const validateCourseInput = (nombre, admin, tipoCurso, area, imagen) => {
  if (!nombre || !admin || !tipoCurso || !area || !imagen) {
    return "Faltan campos obligatorios";
  }
  return null;
};

router.get("/teachers/:userId/courses", async (req, res) => {
  try {
    const userId = req.params.userId;
    const result = await db.execute("SELECT * FROM cursos WHERE admin = ?", [userId]);
    const cursos = result.rows.map(curso => ({ ...curso, isOwner: true }));
    res.json(cursos);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.post("/create-course", async (req, res) => {
  const { nombre, costo, descripcion, admin, tipoCurso, area, imagen } = req.body;

  const validationError = validateCourseInput(nombre, admin, tipoCurso, area, imagen);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    // Verificar si el usuario es profesor
    const [usuario, cursoExistente] = await Promise.all([
      db.execute("SELECT * FROM usuarios WHERE id = ? AND rol = 'profesor'", [admin]),
      db.execute("SELECT * FROM cursos WHERE nombre = ? AND admin = ?", [nombre, admin])
    ]);

    if (usuario.rows.length === 0) {
      return res.status(403).json({ error: "Solo los profesores pueden crear cursos" });
    }
    if (cursoExistente.rows.length > 0) {
      return res.status(409).json({ error: "Ya existe un curso con ese nombre para este profesor" });
    }

    // Crear curso
    const fechaActual = DateTime.utc().toISO();
    await db.execute(
      `INSERT INTO cursos (nombre, fecha, precio, descripcion, admin, tipoCurso, genero, portada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nombre, fechaActual, costo || null, descripcion || null, admin, tipoCurso, area, imagen]
    );

    res.status(201).json({ success: true, message: "Curso creado exitosamente" });
  } catch (error) {
    console.error("Error al crear el curso:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

function formatCourses(rows) {
  return rows.map((course) => {
    course.imagen = course.portada || null;
    delete course.portada;
    return course;
  });
}

router.get("/courses/student/:userId", async (req, res) => {
  try {
    const listCourses = await db.execute(
      "SELECT c.id, c.nombre, c.tipoCurso, c.portada, c.admin FROM cursos c JOIN cursos_estudiante ce ON ce.idCurso = c.id WHERE ce.idUsuario = ?",
      [req.params.userId]
    )

    res.json(listCourses.rows)
  } catch (error) {
    console.log(error)
  }
})

router.get("/AllCourses/:preferences", async (req, res) => {
  try {
    const preferences = decodeURIComponent(req.params.preferences);
    const result = await db.execute({
      sql: "SELECT * FROM cursos ORDER BY genero = ? DESC",
      args: [preferences],
    });

    res.json(formatCourses(result.rows));
  } catch (error) {
    console.error("Error obteniendo cursos:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.get("/filterCourses/:string", async (req, res) => {
  const { string } = req.params;

  try {
    const result = await db.execute({
      sql: "SELECT * FROM cursos WHERE nombre LIKE ? OR descripcion LIKE ?",
      args: [`%${string}%`, `%${string}%`],
    });

    res.json(formatCourses(result.rows));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al filtrar cursos" });
  }
});

router.get("/courses/:courseId", async (req, res) => {
  const cursos = await db.execute(
    "SELECT * FROM cursos WHERE id = ?",
    [req.params.courseId]
  )

  res.json(cursos.rows)
})

router.get("/courses/:courseId/messages", async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT 
        mc.*, 
        u.nombre, 
        u.fotoPerfil
       FROM mensajes_curso mc
       JOIN usuarios u ON u.id = mc.usuario_id
       WHERE mc.curso_id = ?
       ORDER BY mc.fecha_envio ASC`,
      [req.params.courseId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al obtener mensajes del curso");
  }
});

router.delete("/del/courses/:courseId", async (req, res) => {
  const { courseId } = req.params;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.id;

    const curso = await db.execute("SELECT * FROM cursos WHERE id = ? AND admin = ?", [courseId, userId]);
    if (curso.rows.length === 0) {
      return res.status(403).json({ error: "No tienes permiso para eliminar este curso" });
    }

    await db.execute("DELETE FROM cursos WHERE id = ?", [courseId]);
    res.json({ success: true, message: "Curso eliminado exitosamente" });
  } catch (error) {
    console.error("Error al eliminar curso:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.post("/inscription/course", async (req, res) => {
  const { userId, courseId } = req.body;
  console.log(req.body)

  if (!userId || !courseId) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }
  const existingEnrollment = await db.execute("SELECT 1 FROM cursos_estudiante WHERE idUsuario = ? AND idCurso = ?", [userId, courseId]);

  if (existingEnrollment.rows.length > 0) {
    return res.status(409).json({ error: "Ya estás inscrito en este curso" });
  }

  await db.execute("INSERT INTO cursos_estudiante (idUsuario, idCurso) VALUES (?, ?)", [userId, courseId])
    .then(() => {
      res.status(200).json({ success: true, message: "Inscripción exitosa" });
    })
    .catch((error) => {
      console.error("Error al inscribir al curso:", error);
      res.status(500).json({ error: "Error del servidor" });
    });
});

module.exports = router;