const express = require("express");
const router = express.Router();
const db = require("../db");

// Listar foros de un módulo con información de referencia y conteo de respuestas
router.get("/modulos/:idModulo/foros", async (req, res) => {
  try {
    const { idModulo } = req.params;
    
    const result = await db.execute(
      `SELECT 
        f.*, 
        u.nombre AS autor, 
        u.fotoPerfil,
        CASE 
          WHEN f.tipoReferencia = 'grabacion' AND g.id IS NOT NULL THEN g.titulo
          WHEN f.tipoReferencia = 'contenido' AND c.id IS NOT NULL THEN c.titulo
          ELSE NULL 
        END AS referenciaTitulo,
        CASE 
          WHEN f.tipoReferencia = 'grabacion' AND g.id IS NOT NULL THEN g.link
          WHEN f.tipoReferencia = 'contenido' AND c.id IS NOT NULL THEN c.link
          ELSE NULL 
        END AS referenciaEnlace,
        COUNT(rf.id) AS respuestasCount
       FROM foros f
       JOIN usuarios u ON u.id = f.idUsuario
       LEFT JOIN grabaciones g ON f.tipoReferencia = 'grabacion' AND g.id = f.idReferencia
       LEFT JOIN contenido c ON f.tipoReferencia = 'contenido' AND c.id = f.idReferencia
       LEFT JOIN respuestasForo rf ON rf.idForo = f.id
       WHERE f.idModulo = ?
       GROUP BY f.id, u.nombre, u.fotoPerfil, g.titulo, g.link, c.titulo, c.link
       ORDER BY f.fechaCreacion DESC`,
      [idModulo]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error("Error cargando foros:", error);
    res.status(500).json({ error: "Error del servidor al cargar foros" });
  }
});

// Crear un foro
router.post("/foros", async (req, res) => {
  const { idModulo, idUsuario, tipoReferencia, idReferencia, tipoForo, titulo, mensaje } = req.body;

  // Validación de campos obligatorios
  if (!idModulo || !idUsuario || !titulo?.trim() || !mensaje?.trim()) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }

  // Validación específica por tipo de foro
  if (tipoForo !== 'general' && (!tipoReferencia || !idReferencia)) {
    return res.status(400).json({ error: "Los foros de pregunta y aporte requieren una referencia" });
  }

  try {
    // Para foros generales, establecer valores por defecto
    const finalTipoReferencia = tipoForo === 'general' ? 'general' : tipoReferencia;
    const finalIdReferencia = tipoForo === 'general' ? 0 : parseInt(idReferencia);

    const result = await db.execute(
      `INSERT INTO foros (idModulo, idUsuario, tipoReferencia, idReferencia, tipoForo, titulo, mensaje)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [idModulo, idUsuario, finalTipoReferencia, finalIdReferencia, tipoForo, titulo.trim(), mensaje.trim()]
    );

    res.status(201).json({ 
      success: true, 
      message: "Foro creado exitosamente",
      foroId: result.rows[0].id 
    });
  } catch (error) {
    console.error("Error creando foro:", error);
    res.status(500).json({ error: "Error del servidor al crear foro" });
  }
});

// Obtener un foro por ID con sus respuestas e información de referencia completa
router.get("/foros/:idForo", async (req, res) => {
  try {
    const { idForo } = req.params;
    
    // Obtener información del foro
    const foroResult = await db.execute(
      `SELECT 
        f.*, 
        u.nombre AS autor, 
        u.fotoPerfil,
        m.nombre AS moduloNombre,
        CASE 
          WHEN f.tipoReferencia = 'grabacion' AND g.id IS NOT NULL THEN g.titulo
          WHEN f.tipoReferencia = 'contenido' AND c.id IS NOT NULL THEN c.titulo
          ELSE NULL 
        END AS referenciaTitulo,
        CASE 
          WHEN f.tipoReferencia = 'grabacion' AND g.id IS NOT NULL THEN g.link
          WHEN f.tipoReferencia = 'contenido' AND c.id IS NOT NULL THEN c.link
          ELSE NULL 
        END AS referenciaEnlace
       FROM foros f
       JOIN usuarios u ON u.id = f.idUsuario
       JOIN modulos m ON m.id = f.idModulo
       LEFT JOIN grabaciones g ON f.tipoReferencia = 'grabacion' AND g.id = f.idReferencia
       LEFT JOIN contenido c ON f.tipoReferencia = 'contenido' AND c.id = f.idReferencia
       WHERE f.id = ?`,
      [idForo]
    );
    
    if (foroResult.rows.length === 0) {
      return res.status(404).json({ error: "Foro no encontrado" });
    }

    // Obtener respuestas del foro
    const respuestasResult = await db.execute(
      `SELECT r.*, u.nombre AS autor, u.fotoPerfil
       FROM respuestasForo r
       JOIN usuarios u ON u.id = r.idUsuario
       WHERE r.idForo = ?
       ORDER BY r.fechaCreacion ASC`,
      [idForo]
    );

    const foro = {
      ...foroResult.rows[0],
      respuestas: respuestasResult.rows
    };

    res.json(foro);
  } catch (error) {
    console.error("Error obteniendo foro:", error);
    res.status(500).json({ error: "Error del servidor al obtener foro" });
  }
});

// Obtener foros recientes con conteo de respuestas
router.get("/foros-recientes/:limite?", async (req, res) => {
  try {
    const limite = parseInt(req.params.limite) || 10;
    
    const result = await db.execute(
      `SELECT 
        f.*, 
        u.nombre AS autor, 
        m.nombre AS moduloNombre,
        CASE 
          WHEN f.tipoReferencia = 'grabacion' AND g.id IS NOT NULL THEN g.titulo
          WHEN f.tipoReferencia = 'contenido' AND c.id IS NOT NULL THEN c.titulo
          ELSE NULL 
        END AS referenciaTitulo,
        COUNT(rf.id) AS respuestasCount
       FROM foros f
       JOIN usuarios u ON u.id = f.idUsuario
       JOIN modulos m ON m.id = f.idModulo
       LEFT JOIN grabaciones g ON f.tipoReferencia = 'grabacion' AND g.id = f.idReferencia
       LEFT JOIN contenido c ON f.tipoReferencia = 'contenido' AND c.id = f.idReferencia
       LEFT JOIN respuestasForo rf ON rf.idForo = f.id
       GROUP BY f.id, u.nombre, m.nombre, g.titulo, c.titulo
       ORDER BY f.fechaCreacion DESC
       LIMIT ?`,
      [limite]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error("Error cargando foros recientes:", error);
    res.status(500).json({ error: "Error del servidor al cargar foros recientes" });
  }
});

// Eliminar un foro (con transacción para integridad)
router.delete("/foros/:idForo", async (req, res) => {
  try {
    const { idForo } = req.params;
    
    // Usar transacción para asegurar consistencia
    await db.execute("BEGIN");
    
    try {
      // Eliminar respuestas asociadas
      await db.execute("DELETE FROM respuestasForo WHERE idForo = ?", [idForo]);
      
      // Eliminar el foro
      const deleteResult = await db.execute("DELETE FROM foros WHERE id = ? RETURNING id", [idForo]);
      
      if (deleteResult.rows.length === 0) {
        await db.execute("ROLLBACK");
        return res.status(404).json({ error: "Foro no encontrado" });
      }
      
      await db.execute("COMMIT");
      res.json({ success: true, message: "Foro y respuestas eliminados correctamente" });
      
    } catch (error) {
      await db.execute("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error("Error eliminando foro:", error);
    res.status(500).json({ error: "Error del servidor al eliminar foro" });
  }
});

// ==========================
// RESPUESTAS
// ==========================

// Crear respuesta en un foro
router.post("/foros/:idForo/respuestas", async (req, res) => {
  const { idForo } = req.params;
  const { idUsuario, mensaje } = req.body;
  
  if (!idUsuario || !mensaje?.trim()) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  
  try {
    // Verificar que el foro existe
    const foroExists = await db.execute("SELECT id FROM foros WHERE id = ?", [idForo]);
    if (foroExists.rows.length === 0) {
      return res.status(404).json({ error: "Foro no encontrado" });
    }

    // Crear la respuesta
    const result = await db.execute(
      `INSERT INTO respuestasForo (idForo, idUsuario, mensaje)
       VALUES (?, ?, ?) RETURNING id`,
      [idForo, idUsuario, mensaje.trim()]
    );
    
    // Obtener la respuesta creada con información del autor
    const nuevaRespuesta = await db.execute(
      `SELECT r.*, u.nombre AS autor, u.fotoPerfil
       FROM respuestasForo r
       JOIN usuarios u ON u.id = r.idUsuario
       WHERE r.id = ?`,
      [result.rows[0].id]
    );
    
    res.status(201).json({ 
      success: true, 
      message: "Respuesta creada exitosamente",
      respuesta: nuevaRespuesta.rows[0]
    });
  } catch (error) {
    console.error("Error creando respuesta:", error);
    res.status(500).json({ error: "Error del servidor al crear respuesta" });
  }
});

// Obtener respuestas de un foro
router.get("/foros/:idForo/respuestas", async (req, res) => {
  try {
    const { idForo } = req.params;
    
    const respuestas = await db.execute(
      `SELECT r.*, u.nombre AS autor, u.fotoPerfil
       FROM respuestasForo r
       JOIN usuarios u ON u.id = r.idUsuario
       WHERE r.idForo = ?
       ORDER BY r.fechaCreacion ASC`,
      [idForo]
    );
    
    res.json(respuestas.rows);
  } catch (error) {
    console.error("Error obteniendo respuestas:", error);
    res.status(500).json({ error: "Error del servidor al obtener respuestas" });
  }
});

// Eliminar respuesta
router.delete("/respuestas/:idRespuesta", async (req, res) => {
  try {
    const { idRespuesta } = req.params;
    
    const deleteResult = await db.execute(
      "DELETE FROM respuestasForo WHERE id = ? RETURNING id", 
      [idRespuesta]
    );
    
    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: "Respuesta no encontrada" });
    }
    
    res.json({ success: true, message: "Respuesta eliminada correctamente" });
  } catch (error) {
    console.error("Error eliminando respuesta:", error);
    res.status(500).json({ error: "Error del servidor al eliminar respuesta" });
  }
});

// Endpoint para estadísticas del foro
router.get("/modulos/:idModulo/foros/stats", async (req, res) => {
  try {
    const { idModulo } = req.params;
    
    const stats = await db.execute(
      `SELECT 
        tipoForo,
        COUNT(*) as cantidad,
        COUNT(rf.id) as totalRespuestas
       FROM foros f
       LEFT JOIN respuestasForo rf ON rf.idForo = f.id
       WHERE f.idModulo = ?
       GROUP BY tipoForo`,
      [idModulo]
    );
    
    res.json(stats.rows);
  } catch (error) {
    console.error("Error obteniendo estadísticas:", error);
    res.status(500).json({ error: "Error del servidor al obtener estadísticas" });
  }
});

module.exports = router;