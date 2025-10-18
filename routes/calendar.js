const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { DateTime } = require("luxon");

// Cache en memoria
const roomCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 minuto

// 🔹 Rate limiting para evitar 429
const requestQueue = [];
let isProcessingQueue = false;
const MIN_REQUEST_INTERVAL = 2000; // 2 segundos entre requests
let lastRequestTime = 0;

// 🔹 Función de retry con backoff exponencial
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Si es 429, esperamos más tiempo
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers['retry-after'];
        const delay = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : initialDelay * Math.pow(2, i);
        
        console.log(`Rate limited. Reintentando en ${delay}ms (intento ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Si no es 429, no reintentar
        throw error;
      }
    }
  }
  
  throw lastError;
}

// 🔹 Cola de requests para evitar spam
async function queueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    // Esperar si no ha pasado suficiente tiempo
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => 
        setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest)
      );
    }
    
    const { fn, resolve, reject } = requestQueue.shift();
    lastRequestTime = Date.now();
    
    try {
      const result = await retryWithBackoff(fn);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  }
  
  isProcessingQueue = false;
}

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

// ================================
// 📌 GET fechas del curso
// ================================
router.get("/courses/:selectedCourseId/dates", async (req, res) => {
  const { selectedCourseId } = req.params;

  try {
    const result = await db.execute("SELECT 1 FROM cursos WHERE id = ?", [
      selectedCourseId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Curso no existe" });
    }

    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();

    const fechas = await db.execute(
      `SELECT
         f.id, 
         f.inicio, 
         f.final, 
         f.tipo_encuentro AS tipo,
         f.titulo, 
         f.link_mot,
         g.link AS recording_url,
         f.room_id
       FROM fechas f
       LEFT JOIN grabaciones g ON g.idFecha = f.id
       WHERE f.idCurso = ? AND f.final >= ?
       ORDER BY f.inicio ASC`,
      [selectedCourseId, limiteInferior]
    );

    const fechasFormateadas = fechas.rows.map((fecha) => ({
      ...fecha,
      join_link: fecha.room_id
        ? `/courses/${selectedCourseId}/join/${fecha.room_id}`
        : null,
    }));

    return res.json(fechasFormateadas);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    return res.status(500).json({ error: "Error del servidor" });
  }
});

// ================================
// 📌 Proxy de acceso seguro
// ================================
router.get("/courses/:courseId/join/:roomId", async (req, res) => {
  const { courseId, roomId } = req.params;

  const token =
    req.query.auth ||
    req.headers.authorization?.split(" ")[1] ||
    req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: "Token requerido" });
  }

  try {
    const userPayload = jwt.verify(token, JWT_SECRET);
    const hasAccess = await validateUserCourseAccess(userPayload.id, courseId);
    if (!hasAccess) {
      return res.status(403).json({ error: "Sin acceso al curso" });
    }

    const roomResult = await db.execute(
      `SELECT room_id, link_mot FROM fechas WHERE room_id = ? AND idCurso = ?`,
      [roomId, courseId]
    );

    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: "Sala no encontrada" });
    }

    const roomData = roomResult.rows[0];
    let roomToken;
    try {
      const urlParts = roomData.link_mot?.split("?");
      if (urlParts?.length > 1) {
        const urlParams = new URLSearchParams(urlParts[1]);
        roomToken = urlParams.get("token");
      }
    } catch (_) {}

    if (!roomToken) {
      roomToken = jwt.sign({ room_id: roomId, course_id: courseId }, JWT_SECRET);
    }

    const redirectUrl = `${process.env.VIDEOCHAT_URL}/join?token=${roomToken}&user_token=${encodeURIComponent(
      token
    )}`;
    return res.redirect(redirectUrl);
  } catch (err) {
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Token inválido" });
    }
    console.error("Error en proxy:", err);
    return res.status(500).json({ error: "Error interno" });
  }
});

// ================================
// 📌 Crear/actualizar fechas (CON BORRADO Y RATE LIMITING)
// ================================
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
    const isOwner =
      (
        await db.execute(
          `SELECT id FROM cursos WHERE id = ? AND admin = ?`,
          [selectedCourseId, userPayload.id]
        )
      ).rows.length > 0;

    if (!isOwner) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const validSessions = sessions.filter((s) => {
      const startUTC = DateTime.fromISO(s.inicio, {
        zone: s.timezone || "America/Bogota",
      }).toUTC();
      const endUTC = DateTime.fromISO(s.final, {
        zone: s.timezone || "America/Bogota",
      }).toUTC();
      return startUTC.isValid && endUTC.isValid && endUTC > startUTC;
    });

    if (validSessions.length === 0) {
      // 🔹 Si no hay sesiones válidas, borrar todas las fechas futuras del curso
      const ahora = DateTime.utc().toISO();
      await db.execute(
        `DELETE FROM fechas WHERE idCurso = ? AND inicio >= ?`,
        [selectedCourseId, ahora]
      );
      return res.json({ results: [], message: "Todas las fechas futuras fueron eliminadas" });
    }

    // 🔹 PASO 1: Borrar fechas futuras que ya no están en la nueva selección
    const ahora = DateTime.utc().toISO();
    const nuevasFechasLocales = validSessions.map((s) => {
      return DateTime.fromISO(s.inicio, { zone: s.timezone || "America/Bogota" }).toISODate();
    });

    // Obtener fechas actuales del curso
    const fechasActuales = await db.execute(
      `SELECT id, fecha_date FROM fechas WHERE idCurso = ? AND inicio >= ?`,
      [selectedCourseId, ahora]
    );

    // Identificar y borrar fechas que ya no están seleccionadas
    for (const fecha of fechasActuales.rows) {
      if (!nuevasFechasLocales.includes(fecha.fecha_date)) {
        console.log(`Borrando fecha ${fecha.fecha_date} del curso ${selectedCourseId}`);
        await db.execute(`DELETE FROM fechas WHERE id = ?`, [fecha.id]);
      }
    }

    // 🔹 PASO 2: Request con rate limiting y retry al servidor de videollamadas
    const { VIDEOCHAT_URL } = process.env;
    
    const { data } = await queueRequest(async () => {
      return await axios.post(
        `${VIDEOCHAT_URL}/api/calls`,
        {
          course_id: selectedCourseId,
          sessions: validSessions,
        },
        { 
          headers: { 
            Authorization: `Bearer ${jwt.sign({ course_id: selectedCourseId }, JWT_SECRET)}` 
          },
          timeout: 30000 // 30 segundos timeout
        }
      );
    });

    // 🔹 PASO 3: Guardar/actualizar las nuevas fechas en DB
    for (const session of data.results) {
      const { inicio, final, titulo, type, timezone, room_id, link } = session;
      const startUTC = DateTime.fromISO(inicio, { zone: timezone }).toUTC();
      const endUTC = DateTime.fromISO(final, { zone: timezone }).toUTC();
      const localDate = DateTime.fromISO(inicio, { zone: timezone }).toISODate();

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
          link,
          localDate,
          room_id,
        ]
      );
    }

    return res.json({ results: data.results });
  } catch (err) {
    console.error("Error crítico:", err);
    
    // 🔹 Manejo específico de errores
    if (err.response?.status === 429) {
      return res.status(429).json({ 
        error: "Demasiadas solicitudes. Por favor espera un momento e intenta de nuevo.",
        retryAfter: err.response.headers['retry-after'] || 60
      });
    }
    
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: "Tiempo de espera agotado" });
    }
    
    return res.status(500).json({ 
      error: "Error al procesar solicitud",
      details: err.message 
    });
  }
});

// Limpieza del cache
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of roomCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      roomCache.delete(key);
    }
  }
}, CACHE_TTL);

module.exports = router;