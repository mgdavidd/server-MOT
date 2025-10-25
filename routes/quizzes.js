const express = require("express");
const router = express.Router();
const db = require("../db");
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Crear prueba final de módulo
router.post("/modules/:moduleId/quizzes", async (req, res) => {
  const { nota_minima, preguntas } = req.body;
  try {
    const moduleId = req.params.moduleId;
    const preguntasToStore =
      typeof preguntas === "string" ? preguntas : JSON.stringify(preguntas);
    await db.execute(
      "INSERT INTO pruebas_modulo (id_modulo, nota_minima, preguntas) VALUES (?, ?, ?)",
      [moduleId, nota_minima, preguntasToStore]
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Error insertando prueba:", error);
    res.status(500).json({ error: "Error insertando prueba" });
  }
});

// Generar prueba con IA
router.post("/modules/quizzes/ai", async (req, res) => {
  const { contexto, num_preguntas, nivel_dificultad } = req.body;

  try {
    if (!contexto || contexto.trim().length < 100) {
      return res.status(400).json({
        error: "El contexto debe tener al menos 100 caracteres",
      });
    }

    if (!num_preguntas || num_preguntas < 3 || num_preguntas > 25) {
      return res.status(400).json({
        error: "El número de preguntas debe estar entre 3 y 25",
      });
    }

    const nivelesValidos = ["basico", "intermedio", "avanzado"];
    if (!nivel_dificultad || !nivelesValidos.includes(nivel_dificultad)) {
      return res.status(400).json({
        error: "Nivel de dificultad inválido",
      });
    }

    console.log(`Generando ${num_preguntas} preguntas de nivel ${nivel_dificultad}...`);
    console.log(`Contexto recibido: ${contexto.length} caracteres`);

    const prompt = `Basándote en el siguiente contenido del curso, crea ${num_preguntas} preguntas de opción múltiple con nivel de dificultad ${nivel_dificultad}.

CONTENIDO DEL CURSO:
${contexto}

INSTRUCCIONES CRÍTICAS DE FORMATO:
- Nivel ${nivel_dificultad}: ${getNivelDescription(nivel_dificultad)}
- Cada pregunta debe tener entre 3 y 5 opciones distintas entre sí.
- Solo una opción debe ser correcta.
- Las preguntas deben estar directamente relacionadas con el contenido proporcionado.
- Evita preguntas ambiguas o con múltiples respuestas válidas.

FORMATO DE TEXTO IMPORTANTE:
- Usa saltos de línea (\n) cuando sea necesario para mejorar la legibilidad
- Si una pregunta incluye código, ejemplos o listas, usa saltos de línea apropiados
- Para código o ejemplos técnicos, separa cada línea con \n y guiones para listas
- Las opciones también pueden usar \n si contienen múltiples líneas
- Mantén el texto limpio y bien estructurado
- Ejemplo de pregunta con código:
  "¿Cuál es la salida del siguiente código?\n\nconst x = 5;\nconst y = 10;\nconsole.log(x + y);"
- Ejemplo de opción con múltiples líneas:
  "Opción A:\nPrimera línea\nSegunda línea"`

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un experto en crear evaluaciones educativas de alta calidad.

FORMATO DE RESPUESTA:
Debes responder ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, sin explicaciones.

ESTRUCTURA EXACTA:
[
  {
    "texto": "¿Cuál es el concepto principal de...?",
    "opciones": [
      "Opción incorrecta A",
      "Opción correcta B",
      "Opción incorrecta C",
      "Opción incorrecta D"
    ],
    "respuestaCorrecta": 1
  }
]`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 3000,
    });

    const choice = response?.choices && response.choices[0];
    const messageContent = choice?.message?.content || choice?.text || null;

    if (!messageContent) {
      console.error("OpenAI returned unexpected structure:", response);
      return res.status(502).json({ error: "Respuesta inválida de OpenAI" });
    }

    const preguntasGeneradas = messageContent.trim();
    console.log("✓ Preguntas generadas exitosamente");
    console.log("Preview:", preguntasGeneradas.substring(0, 150) + "...");

    try {
      let cleanJson = preguntasGeneradas;
      if (cleanJson.startsWith("```json")) {
        cleanJson = cleanJson.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      } else if (cleanJson.startsWith("```")) {
        cleanJson = cleanJson.replace(/```\n?/g, "");
      }

      const parsed = JSON.parse(cleanJson);
      if (!Array.isArray(parsed)) throw new Error("La respuesta no es un array");

      parsed.forEach((p, idx) => {
        if (
          !p.texto ||
          !p.opciones ||
          !Array.isArray(p.opciones) ||
          typeof p.respuestaCorrecta !== "number"
        ) {
          throw new Error(`Pregunta ${idx + 1} tiene formato inválido`);
        }
      });

      console.log("✓ Validación exitosa");
    } catch (parseError) {
      console.error("Error de validación:", parseError.message);
    }

    res.json({
      success: true,
      preguntas: preguntasGeneradas,
    });
  } catch (error) {
    console.error("Error creando prueba con IA:", error);
    res.status(500).json({
      error: "Error creando prueba con IA",
      detalles: error.message,
    });
  }
});

function getNivelDescription(nivel) {
  const descripciones = {
    basico: "Conceptos fundamentales, definiciones básicas.",
    intermedio: "Aplicación de conceptos, análisis de situaciones.",
    avanzado: "Síntesis de información compleja, evaluación crítica.",
  };
  return descripciones[nivel] || descripciones.intermedio;
}

// Obtener pruebas de un módulo
router.get("/modules/:moduleId/quizzes", async (req, res) => {
  try {
    const { moduleId } = req.params;
    const result = await db.execute(
      "SELECT * FROM pruebas_modulo WHERE id_modulo = ?",
      [moduleId]
    );
    const rows = result.rows || result[0] || [];
    res.json(rows);
  } catch (error) {
    console.error("Error obteniendo pruebas:", error);
    res.status(500).json({ error: "Error obteniendo pruebas" });
  }
});

// Actualizar prueba final
router.put("/modules/:moduleId/quizzes/:quizId", async (req, res) => {
  const { quizId } = req.params;
  const { nota_minima, preguntas } = req.body;
  
  try {
    const preguntasToStore =
      typeof preguntas === "string" ? preguntas : JSON.stringify(preguntas);
      
    await db.execute(
      "UPDATE pruebas_modulo SET nota_minima = ?, preguntas = ? WHERE id = ?",
      [nota_minima, preguntasToStore, quizId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error actualizando prueba:", error);
    res.status(500).json({ error: "Error actualizando prueba" });
  }
});

// Calcular nota de intento
async function calcularNota(respuestas, quizId) {
  const totalPreguntas = respuestas.length;
  if (totalPreguntas === 0) return 0;

  const result = await db.execute(
    "SELECT preguntas FROM pruebas_modulo WHERE id = ?",
    [quizId]
  );
  const rows = result.rows || result[0] || [];
  const preguntasData = rows[0];
  if (!preguntasData) throw new Error("Prueba no encontrada");

  let preguntas = [];
  try {
    const raw = preguntasData.preguntas;
    if (Array.isArray(raw)) {
      preguntas = raw;
    } else if (typeof raw === "string") {
      let parsed = JSON.parse(raw);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      preguntas = Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error("Error parsing preguntas in calcularNota:", err);
  }

  let correctas = 0;
  preguntas.forEach((pregunta, index) => {
    const correcta = Number(pregunta.respuestaCorrecta ?? pregunta.respuesta_correcta);
    const usuario = Number(respuestas[index]);
    if (Number.isFinite(correcta) && usuario === correcta) correctas++;
  });

  return (correctas / totalPreguntas) * 10;
}

// Registrar intento de prueba
router.post("/modules/:moduleId/quizzes/:quizId/attempts", async (req, res) => {
  const { moduleId, quizId } = req.params;
  const { userId, respuestas } = req.body;

  try {
    // Obtener nota previa más alta
    const resultPrev = await db.execute(
      "SELECT nota FROM intentos_prueba WHERE id_prueba = ? AND id_usuario = ? ORDER BY nota DESC LIMIT 1",
      [quizId, userId]
    );
    const prevRows = resultPrev.rows || resultPrev[0] || [];
    const notaPrevia = prevRows[0]?.nota || null;

    // Calcular nota del intento actual
    const nota = await calcularNota(respuestas, quizId);

    // Obtener nota mínima para aprobar
    const resultMin = await db.execute(
      "SELECT nota_minima FROM pruebas_modulo WHERE id = ?",
      [quizId]
    );
    const minRows = resultMin.rows || resultMin[0] || [];
    const notaMinima = minRows[0]?.nota_minima || 7;

    const aprobado = nota >= notaMinima;

    // Registrar el intento
    await db.execute(
      "INSERT INTO intentos_prueba (id_prueba, id_usuario, nota, aprobado) VALUES (?, ?, ?, ?)",
      [quizId, userId, nota, aprobado]
    );

    res.json({ success: true, nota, notaPrevia, aprobado });
  } catch (error) {
    console.error("Error insertando intento de prueba:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener intentos de un usuario para un quiz específico
router.get("/modules/:moduleId/quizzes/:quizId/attempts/:userId", async (req, res) => {
  const { quizId, userId } = req.params;
  try {
    const result = await db.execute(
      "SELECT * FROM intentos_prueba WHERE id_prueba = ? AND id_usuario = ? ORDER BY nota DESC",
      [quizId, userId]
    );
    const rows = result.rows || result[0] || [];
    const nota_maxima = rows.length > 0 ? rows[0].nota : null;
    res.json({ intentos: rows, nota_maxima });
  } catch (error) {
    console.error("Error obteniendo intentos de prueba:", error);
    res.status(500).json({ error: "Error obteniendo intentos de prueba" });
  }
});

// 🔥 ACTUALIZADO: Actualizar o insertar progreso con lógica mejorada
router.post("/courses/:courseId/progress", async (req, res) => {
  const { courseId } = req.params;
  const { id_usuario, id_modulo_actual, nota_maxima, modulo_anterior } = req.body;

  try {
    // Obtener todos los módulos del curso ordenados
    const modulosResult = await db.execute(
      "SELECT id, orden FROM modulos WHERE id_curso = ? ORDER BY orden ASC",
      [courseId]
    );
    const modulos = modulosResult.rows || modulosResult[0] || [];

    // Encontrar el orden del módulo que se está intentando desbloquear
    const moduloActualData = modulos.find(m => m.id === id_modulo_actual);
    const moduloAnteriorData = modulos.find(m => m.id === modulo_anterior);

    if (!moduloActualData) {
      return res.status(400).json({ 
        success: false, 
        error: "Módulo actual no encontrado" 
      });
    }

    // Verificar si ya existe un registro de progreso
    const existing = await db.execute(
      "SELECT * FROM progreso_modulo WHERE id_curso = ? AND id_usuario = ?",
      [courseId, id_usuario]
    );

    const existingRows = existing.rows || existing[0] || [];

    if (existingRows.length > 0) {
      const progresoActual = existingRows[0];
      const moduloActualProgresoData = modulos.find(m => m.id === progresoActual.id_modulo_actual);
      
      // 🔥 CAMBIO CRÍTICO: Permitir actualización si:
      // 1. El nuevo módulo tiene orden mayor o igual al actual
      // 2. O si estamos verificando que ya aprobó este módulo antes
      const ordenActualProgreso = moduloActualProgresoData?.orden || 0;
      const ordenNuevoModulo = moduloActualData.orden || 0;
      
      if (ordenNuevoModulo >= ordenActualProgreso) {
        // Actualizar progreso
        await db.execute(
          `UPDATE progreso_modulo 
           SET id_modulo_actual = ?, nota_maxima = COALESCE(?, nota_maxima) 
           WHERE id_curso = ? AND id_usuario = ?`,
          [id_modulo_actual, nota_maxima, courseId, id_usuario]
        );
        
        return res.json({ 
          success: true, 
          message: "Progreso actualizado correctamente",
          updated: true
        });
      } else {
        // El módulo solicitado está antes del progreso actual, no actualizar
        return res.json({ 
          success: true, 
          message: "Progreso ya está más adelante",
          updated: false
        });
      }
    } else {
      // Crear nuevo progreso
      await db.execute(
        `INSERT INTO progreso_modulo (id_curso, id_usuario, id_modulo_actual, nota_maxima)
         VALUES (?, ?, ?, ?)`,
        [courseId, id_usuario, id_modulo_actual, nota_maxima]
      );
      
      return res.json({ 
        success: true, 
        message: "Progreso creado correctamente",
        updated: true
      });
    }

  } catch (error) {
    console.error("Error actualizando progreso:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/courses/:courseId/progress/:userId", async (req, res) => {
  const { courseId, userId } = req.params;
  try {
    const result = await db.execute(
      "SELECT * FROM progreso_modulo WHERE id_curso = ? AND id_usuario = ?",
      [courseId, userId]
    );
    const rows = result.rows || result[0] || [];
    res.json(rows[0] || {});
  } catch (error) {
    console.error("Error obteniendo progreso:", error);
    res.status(500).json({ error: "Error obteniendo progreso" });
  }
});

module.exports = router;