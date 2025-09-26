const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { DateTime } = require("luxon");

// Cache en memoria para evitar peticiones repetidas
const roomCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 minuto

// Rate limiting interno
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // 100ms mínimo entre peticiones

// Función para validar acceso del usuario al curso
async function validateUserCourseAccess(userId, courseId) {
  try {
    const result = await db.execute(
      `SELECT 1 FROM cursos_estudiante WHERE idUsuario = ? AND idCurso = ? 
       UNION 
       SELECT 1 FROM cursos WHERE id = ? AND admin = ?`,
      [userId, courseId, courseId, userId]
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error("Error validando acceso al curso:", err);
    return false;
  }
}

router.get("/courses/:selectedCourseId/dates", async (req, res) => {
  const { selectedCourseId } = req.params;

  try {
    // Verificar que el curso existe
    const result = await db.execute("SELECT 1 FROM cursos WHERE id = ?", [
      selectedCourseId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Curso no existe" });
    }

    // Obtener fechas desde 2 semanas atrás
    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();

    const fechas = await db.execute(
      `SELECT
         f.id, 
         f.inicio, 
         f.final, 
         f.tipo_encuentro AS tipo,
         f.titulo, 
         f.link_mot AS join_link,
         g.link AS recording_url,
         f.room_id
       FROM fechas f
       LEFT JOIN grabaciones g ON g.idFecha = f.id
       WHERE f.idCurso = ? AND f.final >= ?
       ORDER BY f.inicio ASC`,
      [selectedCourseId, limiteInferior]
    );

    // Devolver las fechas con enlaces seguros a través del proxy
    const fechasFormateadas = fechas.rows.map((fecha) => ({
      ...fecha,
      inicio: fecha.inicio,
      final: fecha.final,
      titulo: fecha.titulo,
      tipo: fecha.tipo,
      // Cambiar el enlace para usar el proxy seguro
      join_link: fecha.room_id ? `/courses/${selectedCourseId}/join/${fecha.room_id}` : null,
      recording_url: fecha.recording_url,
    }));

    return res.json(fechasFormateadas);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

// RUTA PROXY MEJORADA: Autenticación para acceso seguro a videollamadas
router.get("/courses/:courseId/join/:roomId", async (req, res) => {
  const { courseId, roomId } = req.params;
  
  console.log("🔐 [PROXY] Iniciando autenticación proxy");
  console.log("📋 [PROXY] Course ID:", courseId);
  console.log("📋 [PROXY] Room ID:", roomId);
  
  // Obtener token de múltiples fuentes con prioridad
  const token = 
    req.query.auth || // Primero el query parameter (más confiable para redirects)
    req.headers.authorization?.split(" ")[1] ||
    req.cookies.token;
  
  console.log("📋 [PROXY] Token obtenido:", token ? `${token.substring(0, 20)}...` : "NO TOKEN");
  console.log("📋 [PROXY] Query parameters:", req.query);
  console.log("📋 [PROXY] Cookies recibidas:", req.cookies);
  
  if (!token) {
    console.log("❌ [PROXY] Token no encontrado en ninguna fuente");
    return res.status(401).json({ error: "Token de autenticación requerido" });
  }

  try {
    // Verificar token de usuario
    const userPayload = jwt.verify(token, JWT_SECRET);
    console.log("✅ [PROXY] Token válido para usuario:", userPayload.id);
    console.log("📋 [PROXY] Datos del usuario:", {
      id: userPayload.id,
      nombre: userPayload.nombre,
      email: userPayload.email,
      rol: userPayload.rol
    });
    
    // Validar acceso al curso
    const hasAccess = await validateUserCourseAccess(userPayload.id, courseId);
    if (!hasAccess) {
      console.log("❌ [PROXY] Usuario sin acceso al curso");
      return res.status(403).json({ error: "Sin acceso al curso" });
    }
    
    console.log("✅ [PROXY] Acceso al curso validado");
    
    // Verificar que la sala existe y obtener el token de la sala
    const roomResult = await db.execute(
      `SELECT room_id, link_mot FROM fechas WHERE room_id = ? AND idCurso = ?`,
      [roomId, courseId]
    );
    
    if (roomResult.rows.length === 0) {
      console.log("❌ [PROXY] Sala no encontrada en la base de datos");
      return res.status(404).json({ error: "Sala no encontrada" });
    }
    
    const roomData = roomResult.rows[0];
    console.log("✅ [PROXY] Sala encontrada en DB");
    
    // Extraer el token de la sala del link_mot
    let roomToken;
    try {
      const urlParts = roomData.link_mot.split('?');
      if (urlParts.length > 1) {
        const urlParams = new URLSearchParams(urlParts[1]);
        roomToken = urlParams.get('token');
      }
    } catch (err) {
      console.error("❌ [PROXY] Error extrayendo token de sala:", err.message);
    }
    
    if (!roomToken) {
      console.log("❌ [PROXY] Token de sala no encontrado en link_mot");
      // Intentar generar un token nuevo si no existe
      try {
        roomToken = jwt.sign({ room_id: roomId, course_id: courseId }, JWT_SECRET);
        console.log("✅ [PROXY] Token de sala generado nuevo");
      } catch (err) {
        console.log("❌ [PROXY] Error generando token de sala:", err.message);
        return res.status(500).json({ error: "Error en configuración de sala" });
      }
    } else {
      console.log("✅ [PROXY] Token de sala extraído correctamente");
    }
    
    // Crear URL de redirección con el token de usuario como parámetro
    const redirectUrl = `${process.env.VIDEOCHAT_URL}/join?token=${roomToken}&user_token=${encodeURIComponent(token)}`;
    console.log("🚀 [PROXY] Redirigiendo a:", redirectUrl);
    
    return res.redirect(redirectUrl);
    
  } catch (err) {
    console.error("❌ [PROXY] Error en autenticación:", err.message);
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: "Token inválido" });
    }
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Función para hacer peticiones con rate limiting
async function makeRateLimitedRequest(url, payload, headers) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => 
      setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest)
    );
  }
  
  lastRequestTime = Date.now();
  return axios.post(url, payload, { headers, timeout: 5000 });
}

// Función para verificar si necesitamos actualizar las fechas
function needsTimeUpdate(existingStart, existingEnd, newStartUTC, newEndUTC) {
  if (!existingStart || !existingEnd) return true;
  
  const currentStart = DateTime.fromISO(existingStart, { zone: "utc" });
  const currentEnd = DateTime.fromISO(existingEnd, { zone: "utc" });
  
  // Considerar diferentes si hay más de 1 minuto de diferencia
  const startDiff = Math.abs(newStartUTC.diff(currentStart, 'minutes').minutes);
  const endDiff = Math.abs(newEndUTC.diff(currentEnd, 'minutes').minutes);
  
  return startDiff > 1 || endDiff > 1;
}

// Función para obtener o crear/actualizar sala
async function getOrCreateRoom(selectedCourseId, localDate, startUTC, endUTC, existingRoom) {
  const cacheKey = `${selectedCourseId}-${localDate}-${startUTC.toISO()}-${endUTC.toISO()}`;
  
  // Verificar cache con fechas específicas
  if (roomCache.has(cacheKey)) {
    const cached = roomCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`Usando sala desde cache para ${localDate} (${startUTC.toFormat('HH:mm')}-${endUTC.toFormat('HH:mm')})`);
      return {
        room_id: cached.room_id,
        link_mot: cached.link_mot,
        action: 'cached'
      };
    } else {
      roomCache.delete(cacheKey);
    }
  }

  const hasExistingRoom = existingRoom.rows.length > 0 && existingRoom.rows[0].room_id;
  
  // SIEMPRE hacer petición para mantener consistencia entre DBs
  try {
    const { VIDEOCHAT_URL } = process.env;
    const payload = {
      course_id: selectedCourseId,
      start_utc: startUTC.toISO(),
      end_utc: endUTC.toISO(),
      session_date: localDate,
      room_id: hasExistingRoom ? existingRoom.rows[0].room_id : null
    };

    const action = hasExistingRoom ? 'actualizada' : 'creada';
    console.log(`Sala ${action} para ${localDate} (${startUTC.toFormat('HH:mm')}-${endUTC.toFormat('HH:mm')})`);
    
    const { data } = await makeRateLimitedRequest(
      `${VIDEOCHAT_URL}/api/calls`,
      payload,
      { Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` }
    );

    const roomData = {
      room_id: data.room_id,
      link_mot: data.link,
      action: hasExistingRoom ? 'updated' : 'created'
    };

    // Guardar en cache con las fechas específicas
    roomCache.set(cacheKey, {
      room_id: roomData.room_id,
      link_mot: roomData.link_mot,
      timestamp: Date.now()
    });

    return roomData;
  } catch (err) {
    console.error("Error al procesar sala:", err.message);
    
    // Si falla y existe sala previa, usar esa como fallback
    if (hasExistingRoom) {
      console.log(`Usando sala existente como fallback para ${localDate}`);
      return {
        room_id: existingRoom.rows[0].room_id,
        link_mot: existingRoom.rows[0].link_mot,
        action: 'fallback'
      };
    }
    
    return {
      room_id: null,
      link_mot: null,
      action: 'failed'
    };
  }
}

router.post("/courses/:selectedCourseId/dates", async (req, res) => {
  const { sessions = [] } = req.body;
  const { selectedCourseId } = req.params;

  const token = req.headers.authorization?.split(" ")[1];
  let userPayload;
  try {
    userPayload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  try {
    const isOwner = (await db.execute(
      `SELECT id FROM cursos WHERE id = ? AND admin = ?`,
      [selectedCourseId, userPayload.id]
    )).rows.length > 0;

    if (!isOwner) {
      return res.status(403).json({ error: "No autorizado" });
    }

    // Validar sesiones antes de procesarlas
    const validSessions = sessions.filter(s => {
      const { inicio, final } = s;
      if (!inicio || !final) return false;
      
      const startUTC = DateTime.fromISO(inicio, { zone: s.timezone || "America/Bogota" }).toUTC();
      const endUTC = DateTime.fromISO(final, { zone: s.timezone || "America/Bogota" }).toUTC();
      
      return startUTC.isValid && endUTC.isValid && endUTC > startUTC;
    });

    console.log(`Procesando ${validSessions.length} sesiones válidas de ${sessions.length} totales`);

    // Obtener todas las salas existentes de una vez
    const localDates = validSessions.map(s => 
      DateTime.fromISO(s.inicio, { zone: s.timezone || "America/Bogota" }).toISODate()
    );
    
    const existingRooms = await db.execute(
      `SELECT room_id, link_mot, fecha_date FROM fechas 
       WHERE idCurso = ? AND fecha_date IN (${localDates.map(() => '?').join(',')})`,
      [selectedCourseId, ...localDates]
    );

    // Crear mapa de salas existentes
    const roomMap = new Map();
    existingRooms.rows.forEach(room => {
      roomMap.set(room.fecha_date, room);
    });

    const results = [];
    const batchSize = 3; // Procesar en lotes pequeños
    
    for (let i = 0; i < validSessions.length; i += batchSize) {
      const batch = validSessions.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (s) => {
        const { inicio, final, titulo = "Clase", type = "Clase en vivo", timezone = "America/Bogota" } = s;

        const startUTC = DateTime.fromISO(inicio, { zone: timezone }).toUTC();
        const endUTC = DateTime.fromISO(final, { zone: timezone }).toUTC();
        const localDate = DateTime.fromISO(inicio, { zone: timezone }).toISODate();

        try {
          // Buscar sala existente
          const existingRoom = roomMap.get(localDate);
          const mockExistingResult = { rows: existingRoom ? [existingRoom] : [] };

          // Obtener o crear/actualizar sala
          const { room_id, link_mot, action } = await getOrCreateRoom(
            selectedCourseId, 
            localDate, 
            startUTC, 
            endUTC, 
            mockExistingResult
          );

          // Insertar/actualizar en DB
          await db.execute(
            `INSERT INTO fechas (
              inicio, final, tipo_encuentro, idCurso, titulo, link_mot, fecha_date, room_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(idCurso, fecha_date) DO UPDATE SET
              inicio = excluded.inicio,
              final = excluded.final,
              titulo = excluded.titulo,
              tipo_encuentro = excluded.tipo_encuentro,
              link_mot = COALESCE(excluded.link_mot, fechas.link_mot),
              room_id = COALESCE(excluded.room_id, fechas.room_id)`,
            [
              startUTC.toISO(),
              endUTC.toISO(),
              type,
              selectedCourseId,
              titulo,
              link_mot,
              localDate,
              room_id
            ]
          );

          return { 
            date: localDate, 
            status: "success", 
            action: action,
            room_id: room_id ? room_id.substring(0, 8) + '...' : null
          };
        } catch (dbError) {
          console.error(`Error procesando ${localDate}:`, dbError.message);
          return { date: localDate, status: "failed" };
        }
      });

      // Esperar que termine el lote antes del siguiente
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Pausa entre lotes para evitar saturar
      if (i + batchSize < validSessions.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    const actionsCount = {
      created: results.filter(r => r.action === "created").length,
      updated: results.filter(r => r.action === "updated").length,
      cached: results.filter(r => r.action === "cached").length,
      fallback: results.filter(r => r.action === "fallback").length,
      failed: results.filter(r => r.action === "failed").length
    };
    
    console.log(`Procesamiento completado: ${successCount}/${results.length} exitosos`);
    console.log(`Acciones: ${actionsCount.created} creadas, ${actionsCount.updated} actualizadas, ${actionsCount.cached} desde cache, ${actionsCount.fallback} fallback, ${actionsCount.failed} fallidas`);

    return res.json({ 
      results,
      summary: {
        total: results.length,
        successful: successCount,
        failed: results.length - successCount,
        actions: actionsCount
      }
    });
  } catch (err) {
    console.error("Error crítico:", err);
    return res.status(500).json({ error: "Error al procesar solicitud" });
  }
});

// Limpiar cache periódicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of roomCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      roomCache.delete(key);
    }
  }
}, CACHE_TTL);

module.exports = router;