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

// 🆕 RUTA ACTUALIZADA: Generar prueba con IA (recibe contexto desde frontend)
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

INSTRUCCIONES:
- Nivel ${nivel_dificultad}: ${getNivelDescription(nivel_dificultad)}
- Cada pregunta debe tener entre 3 y 5 opciones distintas entre sí.
- Solo una opción debe ser correcta.
- Las preguntas deben estar directamente relacionadas con el contenido proporcionado.
- Evita preguntas ambiguas o con múltiples respuestas válidas.`;

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
    const resultPrev = await db.execute(
      "SELECT nota FROM intentos_prueba WHERE id_prueba = ? AND id_usuario = ? ORDER BY nota DESC LIMIT 1",
      [quizId, userId]
    );
    const prevRows = resultPrev.rows || resultPrev[0] || [];
    const notaPrevia = prevRows[0]?.nota || null;

    const nota = await calcularNota(respuestas, quizId);

    const resultMin = await db.execute(
      "SELECT nota_minima FROM pruebas_modulo WHERE id = ?",
      [quizId]
    );
    const minRows = resultMin.rows || resultMin[0] || [];
    const notaMinima = minRows[0]?.nota_minima || 7;

    const aprobado = nota >= notaMinima;

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

// Obtener intentos de un usuario
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
    console.error("Error obteniendo intento de prueba:", error);
    res.status(500).json({ error: "Error obteniendo intento de prueba" });
  }
});

module.exports = router;
