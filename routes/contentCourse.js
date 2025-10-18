const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { upload, uploadDir } = require("../uploadConfig");
const { DateTime } = require("luxon");
const { getAdminDriveClient } = require("../driveUtils");
const { google } = require("googleapis");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

/* ============================================================
   📹 SUBIR GRABACIÓN DE SESIÓN (ROOM)
============================================================ */
router.post("/api/upload-recording", upload.single("recording"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Archivo no recibido");

    const { adminUserName, selectedModuleId, roomId } = req.body;
    if (!adminUserName || !roomId) throw new Error("Faltan datos obligatorios");

    const { auth, folderId } = await getAdminDriveClient(adminUserName);
    const drive = google.drive({ version: "v3", auth });
    const now = DateTime.utc();

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
      `SELECT f.id, f.titulo FROM fechas f
       JOIN cursos c ON f.idCurso = c.id
       JOIN usuarios u ON c.admin = u.id
       WHERE u.nombre = ? AND f.room_id = ?`,
      [adminUserName, roomId]
    );

    const fechaId = result.rows[0]?.id;
    const fechaTitulo = result.rows[0]?.titulo;
    if (!fechaId) throw new Error("No se encontró la sesión para esta sala");

    const insertResult = await db.execute(
      `INSERT INTO grabaciones (idFecha, titulo, link, id_modulo)
       VALUES (?, ?, ?, ?) RETURNING id`,
      [fechaId, `Grabacion - ${fechaTitulo}`, data.webViewLink, selectedModuleId]
    );

    const insertedId = insertResult.rows?.[0]?.id;

    fs.unlink(req.file.path, () => {});
    res.json({
      success: true,
      id: insertedId !== undefined ? Number(insertedId) : null,
      fileLink: data.webViewLink,
    });
  } catch (error) {
    console.error("Error subiendo grabación:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({
      error: "Error al subir grabación",
      details: error.message,
    });
  }
});

/* ============================================================
   ✏️ ACTUALIZAR GRABACIÓN
============================================================ */
router.post("/update-recording", async (req, res) => {
  const { title, recordingId } = req.body;
  try {
    await db.execute("UPDATE grabaciones SET titulo = ? WHERE id = ?", [title, recordingId]);
    res.json({ success: true, message: "Grabación actualizada correctamente" });
  } catch (error) {
    console.error("Error actualizando grabación:", error);
    res.status(500).json({ success: false, error: "Error al actualizar grabación" });
  }
});

/* ============================================================
   📚 MÓDULOS DE CURSO
============================================================ */
router.get("/modules/course/:courseId", async (req, res) => {
  const { courseId } = req.params;
  try {
    const modules = await db.execute(
      "SELECT * FROM modulos WHERE id_curso = ? ORDER BY orden ASC",
      [courseId]
    );
    if (modules.rows.length === 0) {
      return res.status(404).json({ error: "No se encontraron módulos para este curso" });
    }
    res.json(modules.rows);
  } catch (err) {
    console.error("Error obteniendo módulos:", err);
    res.status(500).json({ error: "Error al obtener módulos del curso" });
  }
});

router.post("/modules/course/:courseId", async (req, res) => {
  const { courseId } = req.params;
  const { title, color } = req.body;

  try {
    const getMaxOrden = await db.execute(
      "SELECT MAX(orden) as maxOrden FROM modulos WHERE id_curso = ?",
      [courseId]
    );
    const nuevoOrden = (getMaxOrden.rows[0]?.maxOrden || 0) + 1;

    await db.execute(
      "INSERT INTO modulos (id_curso, nombre, color, orden) VALUES (?, ?, ?, ?)",
      [courseId, title, color, nuevoOrden]
    );
    res.json({ success: true, message: "Módulo creado correctamente" });
  } catch (error) {
    console.error("Error creando módulo:", error);
    res.status(500).json({ success: false, error: "Error al crear módulo" });
  }
});

/* ============================================================
   📤 SUBIR CONTENIDO DE MÓDULO
============================================================ */
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
      requestBody: { name: fileName, mimeType: req.file.mimetype, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) },
      fields: "id,webViewLink",
    });

    const result = await db.execute(
      "INSERT INTO contenido (id_modulo, titulo, link) VALUES (?, ?, ?) RETURNING id",
      [moduleId, title, data.webViewLink]
    );
    const insertedId = result.rows?.[0]?.id;

    fs.unlink(req.file.path, () => {});
    res.json({
      success: true,
      id: insertedId !== undefined ? Number(insertedId) : null,
      fileLink: data.webViewLink,
    });
  } catch (error) {
    console.error("Error subiendo contenido:", error);
    res.status(500).json({ error: "Error al subir el contenido", details: error.message });
  }
});

/* ============================================================
   🎞️ SUBIR GRABACIÓN PREGRABADA
============================================================ */
router.post("/upload-pre-recording/:moduleId", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Archivo no recibido");

    const { adminUserName, title } = req.body;
    const { moduleId } = req.params;
    if (!adminUserName || !title) {
      throw new Error("Faltan datos obligatorios");
    }

    const { auth, folderId } = await getAdminDriveClient(adminUserName);
    const drive = google.drive({ version: "v3", auth });

    const fileName = `PreGrabado-${Date.now()}-${req.file.originalname}`;

    const { data } = await drive.files.create({
      requestBody: { name: fileName, mimeType: req.file.mimetype, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) },
      fields: "id,webViewLink",
    });

    const result = await db.execute(
      "INSERT INTO grabaciones (idFecha, titulo, link, id_modulo) VALUES (?, ?, ?, ?) RETURNING id",
      [null, title, data.webViewLink, moduleId]
    );
    const insertedId = result.rows?.[0]?.id;

    fs.unlink(req.file.path, () => {});
    res.json({
      success: true,
      id: insertedId !== undefined ? Number(insertedId) : null,
      fileLink: data.webViewLink,
    });
  } catch (error) {
    console.error("Error subiendo grabación pregrabada:", error);
    res.status(500).json({
      error: "Error al subir grabación pregrabada",
      details: error.message,
    });
  }
});

/* ============================================================
   ✏️ ACTUALIZAR CONTENIDO
============================================================ */
router.put("/content/:contentId", async (req, res) => {
  const { contentId } = req.params;
  const { title } = req.body;
  const { authorization } = req.headers;

  if (!title) return res.status(400).json({ error: "Faltan datos obligatorios" });

  try {
    if (authorization) {
      const token = authorization.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      const contentInfo = await db.execute(
        `SELECT c.admin FROM contenido co
         JOIN modulos m ON co.id_modulo = m.id
         JOIN cursos c ON m.id_curso = c.id
         WHERE co.id = ?`,
        [contentId]
      );

      if (contentInfo.rows.length === 0) {
        return res.status(404).json({ error: "Contenido no encontrado" });
      }

      const adminId = contentInfo.rows[0].admin;
      if (decoded.id !== adminId) {
        return res.status(403).json({ error: "No tienes permiso para editar este contenido" });
      }
    }

    await db.execute("UPDATE contenido SET titulo = ? WHERE id = ?", [title, contentId]);
    res.json({ success: true, message: "Contenido actualizado correctamente" });
  } catch (error) {
    console.error("Error actualizando contenido:", error);
    res.status(500).json({ error: "Error al actualizar contenido" });
  }
});

/* ============================================================
   ❌ ELIMINAR CONTENIDO / GRABACIONES / MÓDULOS
============================================================ */
router.delete("/content/:contentId", async (req, res) => {
  const { contentId } = req.params;
  const { link } = req.body;
  const { authorization } = req.headers;

  try {
    if (!authorization) return res.status(401).json({ error: "Token requerido" });
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const contentInfo = await db.execute(
      `SELECT c.admin, u.nombre as admin_nombre
       FROM contenido co
       JOIN modulos m ON co.id_modulo = m.id
       JOIN cursos c ON m.id_curso = c.id
       JOIN usuarios u ON c.admin = u.id
       WHERE co.id = ?`,
      [contentId]
    );

    if (contentInfo.rows.length === 0)
      return res.status(404).json({ error: "Contenido no encontrado" });

    const contentData = contentInfo.rows[0];
    if (decoded.id !== contentData.admin)
      return res.status(403).json({ error: "No tienes permiso para eliminar este contenido" });

    await db.execute("DELETE FROM contenido WHERE id = ?", [contentId]);

    // Eliminar archivo de Drive si aplica
    if (link && link.includes("/d/")) {
      try {
        const { auth } = await getAdminDriveClient(contentData.admin_nombre);
        const drive = google.drive({ version: "v3", auth });
        const fileId = link.split("/d/")[1].split("/")[0];
        await drive.files.delete({ fileId });
      } catch (err) {
        console.error("Error eliminando archivo de Drive:", err);
      }
    }

    res.json({ success: true, message: "Contenido eliminado correctamente" });
  } catch (error) {
    console.error("Error eliminando contenido:", error);
    res.status(500).json({ error: "Error al eliminar contenido" });
  }
});

router.delete("/recordings/:recordingId", async (req, res) => {
  const { recordingId } = req.params;
  const { link } = req.body;
  const { authorization } = req.headers;

  try {
    if (!authorization) return res.status(401).json({ error: "Token requerido" });
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const recordingInfo = await db.execute(
      `SELECT c.admin, u.nombre as admin_nombre
       FROM grabaciones g
       JOIN modulos m ON g.id_modulo = m.id
       JOIN cursos c ON m.id_curso = c.id
       JOIN usuarios u ON c.admin = u.id
       WHERE g.id = ?`,
      [recordingId]
    );

    if (recordingInfo.rows.length === 0)
      return res.status(404).json({ error: "Grabación no encontrada" });

    const recordingData = recordingInfo.rows[0];
    if (decoded.id !== recordingData.admin)
      return res.status(403).json({ error: "No tienes permiso para eliminar esta grabación" });

    await db.execute("DELETE FROM grabaciones WHERE id = ?", [recordingId]);

    if (link && link.includes("/d/")) {
      try {
        const { auth } = await getAdminDriveClient(recordingData.admin_nombre);
        const drive = google.drive({ version: "v3", auth });
        const fileId = link.split("/d/")[1].split("/")[0];
        await drive.files.delete({ fileId });
      } catch (err) {
        console.error("Error eliminando archivo de Drive:", err);
      }
    }

    res.json({ success: true, message: "Grabación eliminada correctamente" });
  } catch (error) {
    console.error("Error eliminando grabación:", error);
    res.status(500).json({ error: "Error al eliminar grabación" });
  }
});

router.delete("/modules/:moduleId", async (req, res) => {
  const { moduleId } = req.params;
  const authHeader = req.headers.authorization;

  try {
    const moduleInfo = await db.execute(
      `SELECT c.admin FROM modulos m
       JOIN cursos c ON m.id_curso = c.id
       WHERE m.id = ?`,
      [moduleId]
    );

    if (moduleInfo.rows.length === 0)
      return res.status(404).json({ error: "Módulo no encontrado" });

    const moduleData = moduleInfo.rows[0];
    if (authHeader) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.id !== moduleData.admin)
        return res.status(403).json({ error: "No tienes permiso para eliminar este módulo" });
    }

    await db.execute("DELETE FROM modulos WHERE id = ?", [moduleId]);
    res.json({ success: true, message: "Módulo eliminado exitosamente" });
  } catch (error) {
    console.error("Error eliminando módulo:", error);
    res.status(500).json({ error: "Error al eliminar módulo", details: error.message });
  }
});

module.exports = router;
