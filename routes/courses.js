const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const { upload } = require("../uploadConfig");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { getAdminDriveClient } = require("../driveUtils");

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
    const result = await db.execute(
      `INSERT INTO cursos (nombre, fecha, precio, descripcion, admin, tipoCurso, genero, portada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [nombre, fechaActual, costo || null, descripcion || null, admin, tipoCurso, area, imagen]
    );

    const newCourseId = result.rows[0].id;

    res.status(201).json({
      success: true,
      message: "Curso creado exitosamente",
      id: newCourseId
    });
  } catch (error) {
    console.error("Error al crear el curso:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.delete("/courses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.execute("DELETE FROM cursos WHERE id = ?", [id]);
    res.json({ success: true, message: "Curso eliminado" });
  } catch (error) {
    console.error("Error eliminando curso:", error);
    res.status(500).json({ success: false, error: "Error eliminando curso" });
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

router.post("/courses/:courseId/video/introduction", upload.single("video"), async (req, res) => {
  const { courseId } = req.params;

  try {
    if (!req.file) throw new Error("Archivo de video no recibido");

    // Verificar que el curso exista
    const curso = await db.execute("SELECT admin FROM cursos WHERE id = ?", [courseId]);
    if (curso.rows.length === 0) {
      return res.status(404).json({ error: "Curso no encontrado" });
    }

    // Verificar si ya tiene video
    const existing = await db.execute("SELECT 1 FROM video_introduccion WHERE id_curso = ?", [courseId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "El curso ya tiene un video de introducción" });
    }

    const adminId = curso.rows[0].admin;

    const { auth, folderId } = await getAdminDriveClient(adminId);
    const drive = google.drive({ version: "v3", auth });

    const ext = path.extname(req.file.originalname);
    const fileName = `IntroCurso-${courseId}-${Date.now()}${ext}`;
    const { data } = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: req.file.mimetype,
        parents: [folderId],
      },
      media: {
        mimeType: req.file.mimetype,
        body: fs.createReadStream(req.file.path),
      },
      fields: "id,webViewLink",
    });

    await db.execute("INSERT INTO video_introduccion (link, id_curso) VALUES (?, ?)", [
      data.webViewLink,
      courseId,
    ]);

    fs.unlink(req.file.path, () => {});
    res.json({ success: true, fileLink: data.webViewLink });
  } catch (error) {
    console.error("Error subiendo video de introducción:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Error al subir el video", details: error.message });
  }
});

router.get("/courses/:courseId/video/introduction", async (req, res) => {
  const { courseId } = req.params;
  try {
    const result = await db.execute("SELECT link FROM video_introduccion WHERE id_curso = ?", [courseId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No hay video de introducción para este curso" });
    }
    res.json({ link: result.rows[0].link });
  } catch (error) {
    console.error("Error obteniendo video de introducción:", error);
    res.status(500).json({ error: "Error al obtener video de introducción" });
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

// Modificar la ruta de inscripción
router.post("/inscription/course", async (req, res) => {
  const { userId, courseId } = req.body;

  try {
    if (!userId || !courseId) {
      return res.status(400).json({ error: "Faltan datos requeridos" });
    }

    // Verificar inscripción existente
    const existingEnrollment = await db.execute(
      "SELECT 1 FROM cursos_estudiante WHERE idUsuario = ? AND idCurso = ?", 
      [userId, courseId]
    );

    if (existingEnrollment.rows.length > 0) {
      return res.status(409).json({ error: "Ya estás inscrito en este curso" });
    }

    // Obtener el primer módulo del curso (si existe)
    const firstModule = await db.execute(
      "SELECT id FROM modulos WHERE id_curso = ? ORDER BY orden ASC LIMIT 1",
      [courseId]
    );

    // Iniciar transacción
    await db.execute("BEGIN");

    // Inscribir al estudiante
    await db.execute(
      "INSERT INTO cursos_estudiante (idUsuario, idCurso) VALUES (?, ?)",
      [userId, courseId]
    );

    // Crear progreso inicial
    if (firstModule.rows.length > 0) {
      await db.execute(
        `INSERT INTO progreso_modulo (id_curso, id_usuario, id_modulo_actual, nota_maxima)
         VALUES (?, ?, ?, ?)`,
        [courseId, userId, firstModule.rows[0].id, 0]
      );
    }

    await db.execute("COMMIT");

    res.status(200).json({ 
      success: true, 
      message: "Inscripción exitosa",
      firstModuleId: firstModule.rows[0]?.id || null
    });

  } catch (error) {
    await db.execute("ROLLBACK");
    console.error("Error al inscribir al curso:", error);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;