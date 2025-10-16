const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { upload, uploadDir } = require("../uploadConfig");
const { DateTime } = require("luxon");
const { getAdminDriveClient } = require("../driveUtils");
const { google } = require("googleapis");
const jwt = require("jsonwebtoken")
const JWT_SECRET = process.env.JWT_SECRET || 'clave_super_segura';

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
    const fechaTitulo = result.rows[0]?.titulo
    if (!fechaId) throw new Error("No se encontró la sesión para esta sala");

    await db.execute(
      `INSERT INTO grabaciones (idFecha, titulo, link, id_modulo)
       VALUES (?, ?, ?, ?)`,
      [
        fechaId,
        `Grabacion - ${fechaTitulo}`,
        data.webViewLink,
        selectedModuleId
      ]
    );

    fs.unlink(req.file.path, () => { });
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
  const { authorization } = req.headers
  try {
    const modules = await db.execute(
      "SELECT * FROM modulos WHERE id_curso = ? ORDER BY orden ASC",
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
    const getMaxOrden = await db.execute(
      "SELECT MAX(orden) as maxOrden FROM modulos WHERE id_curso = ?",
      [courseId]
    );
    const nuevoOrden = (getMaxOrden.rows[0]?.maxOrden || 0) + 1;

    await db.execute(
      "INSERT INTO modulos (id_curso, nombre, color, orden) VALUES (?, ?, ?, ?)",
      [courseId, title, color, nuevoOrden]
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

    fs.unlink(req.file.path, () => { });
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

// 🔧 CORRECCIÓN: Este endpoint debe reemplazar el existente en routes/contentCourse.js

router.get("/courses/:courseId/modules/:userId", async (req, res) => {
  const { courseId, userId } = req.params;

  try {
    // Verificar acceso al curso
    const accessCheck = await db.execute(`
      SELECT 1 FROM cursos c
      LEFT JOIN cursos_estudiante ce ON ce.idCurso = c.id AND ce.idUsuario = ?
      WHERE c.id = ? AND (c.admin = ? OR ce.idUsuario IS NOT NULL)
    `, [userId, courseId, userId]);

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: "No tienes acceso a este curso" });
    }

    // Obtener todos los módulos del curso ordenados
    const result = await db.execute(
      "SELECT * FROM modulos WHERE id_curso = ? ORDER BY orden ASC",
      [courseId]
    );

    // Verificar rol del usuario
    const userInfo = await db.execute(
      "SELECT rol FROM usuarios WHERE id = ?",
      [userId]
    );

    if (userInfo.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const userRole = userInfo.rows[0].rol;

    // Si es profesor, devolver todos los módulos sin restricciones
    if (userRole === "profesor") {
      return res.json(result.rows);
    }

    // Si es estudiante, manejar progreso
    const modulos = result.rows;

    // Obtener progreso actual
    const progresoResult = await db.execute(
      "SELECT * FROM progreso_modulo WHERE id_curso = ? AND id_usuario = ?",
      [courseId, userId]
    );

    let progreso = progresoResult.rows[0] || null;
    let idModuloActual = null;

    // Determinar módulo actual
    if (progreso) {
      idModuloActual = progreso.id_modulo_actual;
    } else if (modulos.length > 0) {
      // Si no hay progreso, inicializar con el primer módulo
      const primerModulo = modulos.find(m => m.orden === 1) || modulos[0];
      idModuloActual = primerModulo.id;

      // Crear registro de progreso inicial
      try {
        await db.execute(
          "INSERT INTO progreso_modulo (id_curso, id_usuario, id_modulo_actual) VALUES (?, ?, ?)",
          [courseId, userId, idModuloActual]
        );
        
        // Actualizar progreso local
        progreso = {
          id_modulo_actual: idModuloActual,
          id_curso: courseId,
          id_usuario: userId,
          nota_maxima: null
        };
      } catch (err) {
        console.error("Error creando progreso inicial:", err);
      }
    }

    // Encontrar el orden del módulo actual
    const moduloActual = modulos.find(m => m.id === idModuloActual);
    const ordenModuloActual = moduloActual ? moduloActual.orden : 1;

    // Marcar módulos como bloqueados o desbloqueados
    const modulosConEstado = modulos.map(modulo => ({
      ...modulo,
      desbloqueado: modulo.orden <= ordenModuloActual
    }));

    return res.json({
      result: modulosConEstado,
      progresoActual: progreso || { id_modulo_actual: idModuloActual }
    });

  } catch (error) {
    console.error("Error al obtener módulos:", error);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

router.get("/modules/recordings/:moduleId", async (req, res) => {
  const { moduleId } = req.params;
  try {
    // LEFT JOIN para incluir grabaciones pregrabadas (idFecha = NULL)
    const recordings = await db.execute(
      `SELECT 
        g.id, 
        g.titulo, 
        g.link, 
        f.inicio,
        CASE 
          WHEN g.idFecha IS NULL THEN 'pregrabado'
          ELSE 'sesion'
        END as tipo_grabacion
       FROM grabaciones g 
       LEFT JOIN fechas f ON g.idFecha = f.id 
       WHERE g.id_modulo = ? 
       ORDER BY 
         CASE 
           WHEN f.inicio IS NOT NULL THEN f.inicio 
           ELSE g.id 
         END DESC`,
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

router.get("/modules/content/:moduleId", async (req, res) => {
  const { moduleId } = req.params;
  try {
    const result = await db.execute(
      "SELECT * FROM contenido WHERE id_modulo = ? ORDER BY id ASC",
      [moduleId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error obteniendo contenido del módulo:", error);
    res.status(500).json({ error: "Error al obtener contenido del módulo" });
  }
});

router.post("/modules/:moduleId/content", async (req, res) => {
  const { moduleId } = req.params;
  const { titulo, link } = req.body;

  if (!titulo || !link) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    await db.execute(
      "INSERT INTO contenido (id_modulo, titulo, link) VALUES (?, ?, ?)",
      [moduleId, titulo, link]
    );
    res.json({ success: true, message: "Contenido creado correctamente" });
  } catch (error) {
    console.error("Error creando contenido:", error);
    res.status(500).json({ error: "Error al crear contenido" });
  }
});

// Subida de grabaciones pregrabadas (sin fecha)
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

    // Guardar en la tabla grabaciones con idFecha = NULL
    await db.execute(
      "INSERT INTO grabaciones (idFecha, titulo, link, id_modulo) VALUES (?, ?, ?, ?)",
      [null, title, data.webViewLink, moduleId]
    );

    fs.unlink(req.file.path, () => { });
    res.json({
      success: true,
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

//actualizar y eliminar los elementos
router.put("/content/:contentId", async (req, res) => {
  const { contentId } = req.params
  const { title } = req.body;
  const { authorization } = req.headers
  if (!title ) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  if (authorization) {
    const token = authorization.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.id !== moduleData.admin) {
      return res.status(403).json({ error: "No tienes permiso para eliminar este módulo" });
    }
  }

  try {
    await db.execute(
      "UPDATE contenido SET titulo = ? WHERE id = ?",
      [title, contentId]
    )
    res.json({ success: true, message: "Contenido actualizado correctamente" });
  } catch (error) {
    console.error("Error actualizando contenido:", error);
    res.status(500).json({ error: "Error al actualizar contenido" });
  }
})

// Rutas de eliminación corregidas para contentCourse.js

router.delete("/content/:contentId", async (req, res) => {
  const { contentId } = req.params;
  const { link } = req.body;
  const { authorization } = req.headers;
  
  try {
    // Primero verificar permisos
    if (authorization) {
      const token = authorization.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      // Obtener información del contenido y verificar permisos
      const contentInfo = await db.execute(
        `SELECT c.id as course_id, c.admin, u.nombre as admin_nombre
         FROM contenido co
         JOIN modulos m ON co.id_modulo = m.id
         JOIN cursos c ON m.id_curso = c.id
         JOIN usuarios u ON c.admin = u.id
         WHERE co.id = ?`,
        [contentId]
      );

      if (contentInfo.rows.length === 0) {
        return res.status(404).json({ error: "Contenido no encontrado" });
      }

      const contentData = contentInfo.rows[0];

      if (decoded.id !== contentData.admin) {
        return res.status(403).json({ error: "No tienes permiso para eliminar este contenido" });
      }

      // Eliminar de la base de datos
      await db.execute("DELETE FROM contenido WHERE id = ?", [contentId]);
      
      // Eliminar de Drive si hay link
      if (link && link.includes("/d/")) {
        try {
          const { auth } = await getAdminDriveClient(contentData.admin_nombre);
          const drive = google.drive({ version: "v3", auth });
          const fileId = link.split("/d/")[1].split("/")[0];
          await drive.files.delete({ fileId });
        } catch (driveError) {
          console.error("Error eliminando archivo de Drive:", driveError);
          // No fallar si el archivo ya no existe en Drive
        }
      }

      return res.json({ success: true, message: "Contenido eliminado correctamente" });
    } else {
      return res.status(401).json({ error: "Token de autorización requerido" });
    }

  } catch (error) {
    console.error("Error eliminando contenido:", error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: "Token inválido" });
    }

    return res.status(500).json({ error: "Error al eliminar contenido" });
  }
});

router.delete("/recordings/:recordingId", async (req, res) => {
  const { recordingId } = req.params;
  const { link } = req.body;
  const { authorization } = req.headers;

  try {
    // Primero verificar permisos
    if (authorization) {
      const token = authorization.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      // Obtener información de la grabación y verificar permisos
      const recordingInfo = await db.execute(
        `SELECT c.id as course_id, c.admin, u.nombre as admin_nombre
         FROM grabaciones g
         JOIN modulos m ON g.id_modulo = m.id
         JOIN cursos c ON m.id_curso = c.id
         JOIN usuarios u ON c.admin = u.id
         WHERE g.id = ?`,
        [recordingId]
      );

      if (recordingInfo.rows.length === 0) {
        return res.status(404).json({ error: "Grabación no encontrada" });
      }

      const recordingData = recordingInfo.rows[0];

      if (decoded.id !== recordingData.admin) {
        return res.status(403).json({ error: "No tienes permiso para eliminar esta grabación" });
      }

      // Eliminar de la base de datos
      await db.execute("DELETE FROM grabaciones WHERE id = ?", [recordingId]);

      // Eliminar de Drive si hay link
      if (link && link.includes("/d/")) {
        try {
          const { auth } = await getAdminDriveClient(recordingData.admin_nombre);
          const drive = google.drive({ version: "v3", auth });
          const fileId = link.split("/d/")[1].split("/")[0];
          await drive.files.delete({ fileId });
        } catch (driveError) {
          console.error("Error eliminando archivo de Drive:", driveError);
          // No fallar si el archivo ya no existe en Drive
        }
      }

      return res.json({ success: true, message: "Grabación eliminada correctamente" });
    } else {
      return res.status(401).json({ error: "Token de autorización requerido" });
    }

  } catch (error) {
    console.error("Error eliminando grabación:", error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: "Token inválido" });
    }

    return res.status(500).json({ error: "Error al eliminar grabación" });
  }
});

router.delete("/modules/:moduleId", async (req, res) => {
  const { moduleId } = req.params;
  const authHeader = req.headers.authorization;


  try {
    const moduleInfo = await db.execute(
      `SELECT c.id as course_id, c.admin, u.id as user_id 
       FROM modulos m
       JOIN cursos c ON m.id_curso = c.id
       JOIN usuarios u ON c.admin = u.id
       WHERE m.id = ?`,
      [moduleId]
    );

    if (moduleInfo.rows.length === 0) {
      return res.status(404).json({ error: "Módulo no encontrado" });
    }

    const moduleData = moduleInfo.rows[0];

    if (authHeader) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      if (decoded.id !== moduleData.admin) {
        return res.status(403).json({ error: "No tienes permiso para eliminar este módulo" });
      }
    }

    await db.execute("DELETE FROM modulos WHERE id = ?", [moduleId]);

    res.json({
      success: true,
      message: "Módulo eliminado exitosamente"
    });

  } catch (error) {
    console.error("Error eliminando módulo:", error);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: "Token inválido" });
    }

    res.status(500).json({
      error: "Error al eliminar módulo",
      details: error.message
    });
  }
});


module.exports = router;
