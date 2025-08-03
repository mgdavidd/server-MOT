const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { upload, uploadDir } = require("../uploadConfig");
const { DateTime } = require("luxon");
const { getAdminDriveClient } = require("../driveUtils");
const { google } = require("googleapis");

router.get("/my-recordings/:userId/:courseId", async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT g.id, g.idFecha, g.titulo, g.link, f.fecha_date, f.idCurso, f.tipo_encuentro
       FROM grabaciones g
       JOIN fechas f ON g.idFecha = f.id 
       JOIN cursos c ON f.idCurso = c.id
       JOIN usuarios u ON c.admin = u.id
       WHERE u.id = ? AND c.id = ?
       ORDER BY f.inicio DESC`,
      [req.params.userId, req.params.courseId]
    );
    res.json({ recordings: result.rows });
  } catch (err) {
    console.error("Error obteniendo grabaciones:", err);
    res.json({
      recordings: [],
      error: "No se pudieron obtener las grabaciones",
    });
  }
});

router.post("/api/upload-recording", upload.single("recording"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Archivo no recibido");

    const { adminUserName, selectedModuleId } = req.body;
    if (!adminUserName) throw new Error("Faltan datos obligatorios");

    const { auth, folderId } = await getAdminDriveClient(adminUserName);
    const drive = google.drive({ version: "v3", auth });

    const now = DateTime.utc();
    const fechaLocal = now.setZone("America/Bogota").toISODate();

    const { data } = await drive.files.create({
      requestBody: {
        name: `Grabacion-${adminUserName}-${now.toFormat("yyyyLLdd-HHmmss")}.webm`,
        mimeType: "video/webm",
        parents: [folderId],
      },
      media: {
        mimeType: "video/webm",
        body: fs.createReadStream(req.file.path),
      },
      fields: "id,webViewLink",
    });

    const result = await db.execute(
      `SELECT f.id FROM fechas f
       JOIN cursos c ON f.idCurso = c.id
       JOIN usuarios u ON c.admin = u.id
       WHERE u.nombre = ? AND f.fecha_date = ?`,
      [adminUserName, fechaLocal]
    );
    const fechaId = result.rows[0]?.id;

    if (!fechaId) throw new Error("No se encontró la sesión para la fecha actual");

    await db.execute(
      `INSERT INTO grabaciones (idFecha, titulo, link, id_modulo)
       VALUES (?, ?, ?, ?)`,
      [
        fechaId,
        `Grabación ${now.toFormat("yyyyLLdd-HHmmss")}`,
        data.webViewLink,
        selectedModuleId
      ]
    );

    fs.unlink(req.file.path, () => {});
    res.json({
      success: true,
      fileId: data.id,
      fileLink: data.webViewLink,
    });
  } catch (error) {
    console.error("Error subiendo grabación:", error);

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      error: "Error al subir",
      details: error.message,
    });
  }
});

router.post("/update-recording", async (req, res) => {
  const { title, recordingId } = req.body;
  try {
    await db.execute(
      "UPDATE grabaciones SET titulo = ? WHERE id = ?",
      [title, recordingId]
    );
    res.json({
      success: true,
      message: "Grabación actualizada correctamente",
    });
  } catch (error) {
    console.error("Error actualizando grabación:", error);
    res.status(500).json({
      success: false,
      error: "Error al actualizar grabación",
    });
  }
});

router.get("/modules/course/:courseId", async (req, res) => {
  const { courseId } = req.params;
  try {
    const modules = await db.execute(
      "SELECT * FROM modulos WHERE id_curso = ? ORDER BY id ASC",
      [courseId]
    );
    if (modules.rows.length === 0) {
      return res.status(404).json({ error: "No se encontraron Módulos para este curso" });
    }
    res.json(modules.rows);
  } catch (err) {
    console.error("Error obteniendo módulos:", err);
    res.status(500).json({ error: "Error al obtener módulos del curso " + courseId });
  }
});

router.post("/modules/course/:courseId", async (req, res) => {
  const { courseId } = req.params;
  const { title, color } = req.body;

  try {
    await db.execute(
      "INSERT INTO modulos (id_curso, nombre, color) VALUES (?, ?, ?)",
      [courseId, title, color]
    );
    res.json({
      success: true,
      message: "Módulo creado correctamente",
    });
  } catch (error) {
    console.error("Error creando módulo:", error);
    res.status(500).json({
      success: false,
      error: "Error al crear módulo",
    });
  }
});

router.get("/courses/content/:curso", async (req, res) => {
  const { curso } = req.params;
  const courseContent = await db.execute(
    "SELECT * FROM modulos WHERE id_curso = ? ORDER BY id ASC",
    [curso]
  );
  res.json(courseContent.rows);
});

router.post("/upload-module-content/:moduleId", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Archivo no recibido");

    const { courseName, adminUserName, title } = req.body;
    const { moduleId } = req.params;

    if (!courseName || !moduleId || !adminUserName || !title) {
      throw new Error("Faltan datos obligatorios");
    }

    const { auth, folderId } = await getAdminDriveClient(adminUserName);
    const drive = google.drive({ version: "v3", auth });

    const originalExt = path.extname(req.file.originalname);
    const fileName = `Contenido-${courseName}-${Date.now()}${originalExt}`;

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

    await db.execute(
      "INSERT INTO contenido (id_modulo, titulo, link) VALUES (?, ?, ?)",
      [moduleId, title, data.webViewLink]
    );

    fs.unlink(req.file.path, () => {});
    res.json({
      success: true,
      fileLink: data.webViewLink,
    });

  } catch (error) {
    console.error("Error subiendo contenido:", error);

    res.status(500).json({
      error: "Error al subir el contenido",
      details: error.message,
    });
  }
});

router.get("/courses/:courseId/modules/:userId", async (req, res) => {
  const { courseId, userId } = req.params;

  try {
    const accessCheck = await db.execute(`
      SELECT 1 FROM cursos c
      LEFT JOIN cursos_estudiante ce ON ce.idCurso = c.id AND ce.idUsuario = ?
      WHERE c.id = ? AND (c.admin = ? OR ce.idUsuario IS NOT NULL)
    `, [userId, courseId, userId]);

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: "No tienes acceso a este curso" });
    }

    const result = await db.execute(
      "SELECT * FROM modulos WHERE id_curso = ? ORDER BY id",
      [courseId]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener módulos:", error);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

router.get("/modules/recordings/:moduleId", async (req, res) => {
  const { moduleId } = req.params;
  try {
    const recordings = await db.execute(
      "SELECT g.id, g.titulo, g.link, f.inicio FROM grabaciones g JOIN fechas f ON g.idFecha = f.id WHERE g.id_modulo = ? ORDER BY g.id ASC",
      [moduleId]
    );
    res.json(recordings.rows);
  } catch (error) {
    console.error("Error obteniendo grabaciones:", error);
    res.status(500).json({
      error: "Error al obtener grabaciones del módulo",
      details: error.message,
    });
  }
});



module.exports = router;
