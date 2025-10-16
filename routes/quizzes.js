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
        // Evitar double-stringify: si preguntas ya es string (JSON), guardarlo tal cual,
        // si es array/obj guardarlo como JSON string.
        const preguntasToStore = typeof preguntas === "string" ? preguntas : JSON.stringify(preguntas);
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
    // Validaciones
    if (!contexto || contexto.trim().length < 100) {
      return res.status(400).json({ 
        error: "El contexto debe tener al menos 100 caracteres" 
      });
    }

    if (!num_preguntas || num_preguntas < 3 || num_preguntas > 25) {
      return res.status(400).json({ 
        error: "El número de preguntas debe estar entre 3 y 25" 
      });
    }

    const nivelesValidos = ["basico", "intermedio", "avanzado"];
    if (!nivel_dificultad || !nivelesValidos.includes(nivel_dificultad)) {
      return res.status(400).json({ 
        error: "Nivel de dificultad inválido" 
      });
    }

    console.log(`Generando ${num_preguntas} preguntas de nivel ${nivel_dificultad}...`);
    console.log(`Contexto recibido: ${contexto.length} caracteres`);

    // Construir el prompt optimizado
    const prompt = `Basándote en el siguiente contenido del curso, crea ${num_preguntas} preguntas de opción múltiple con nivel de dificultad ${nivel_dificultad}.

CONTENIDO DEL CURSO:
${contexto}

INSTRUCCIONES:
- Nivel ${nivel_dificultad}: ${getNivelDescription(nivel_dificultad)}
- Cada pregunta debe tener entre 3 y 5 opciones distintas entre sí (para evitar exámenes repetitivos, siempre a o siempre b)
- Solo una opción debe ser correcta
- Las preguntas deben estar directamente relacionadas con el contenido proporcionado
- Evita preguntas ambiguas o con múltiples respuestas válidas`;

    // Llamar a OpenAI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres un experto en crear evaluaciones educativas de alta calidad.

FORMATO DE RESPUESTA (CRÍTICO):
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
]

REGLAS:
- respuestaCorrecta es el índice (0-based) de la opción correcta
- Mínimo 3 opciones, máximo 5 opciones por pregunta
- Cada opción debe ser clara y concisa
- La respuesta correcta debe ser inequívoca`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    // Validar estructura de response antes de usarla
    const choice = response?.choices && response.choices[0];
    const messageContent = choice?.message?.content || choice?.text || null;

    if (!messageContent) {
      console.error("OpenAI returned unexpected structure:", response);
      return res.status(502).json({ error: "Respuesta inválida de OpenAI" });
    }

    const preguntasGeneradas = messageContent.trim();
    
    console.log("✓ Preguntas generadas exitosamente");
    console.log("Preview:", preguntasGeneradas.substring(0, 150) + "...");

    // Intentar parsear para validar formato
    try {
      let cleanJson = preguntasGeneradas;
      if (cleanJson.startsWith("```json")) {
        cleanJson = cleanJson.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      } else if (cleanJson.startsWith("```")) {
        cleanJson = cleanJson.replace(/```\n?/g, "");
      }
      
      const parsed = JSON.parse(cleanJson);
      
      // Validar estructura
      if (!Array.isArray(parsed)) {
        throw new Error("La respuesta no es un array");
      }
      
      if (parsed.length !== num_preguntas) {
        console.warn(`Se generaron ${parsed.length} preguntas en lugar de ${num_preguntas}`);
      }

      // Validar cada pregunta
      parsed.forEach((p, idx) => {
        if (!p.texto || !p.opciones || !Array.isArray(p.opciones) || typeof p.respuestaCorrecta !== 'number') {
          throw new Error(`Pregunta ${idx + 1} tiene formato inválido`);
        }
        if (p.opciones.length < 3 || p.opciones.length > 5) {
          throw new Error(`Pregunta ${idx + 1} debe tener entre 3 y 5 opciones`);
        }
        if (p.respuestaCorrecta < 0 || p.respuestaCorrecta >= p.opciones.length) {
          throw new Error(`Pregunta ${idx + 1} tiene índice de respuesta inválido`);
        }
      });

      console.log("✓ Validación exitosa");
    } catch (parseError) {
      console.error("Error de validación:", parseError.message);
      // Aún así devolvemos la respuesta para que el frontend intente parsearla
    }

    res.json({ 
      success: true, 
      preguntas: preguntasGeneradas
    });

  } catch (error) {
    console.error("Error creando prueba con IA:", error);
    
    // Mensajes de error más específicos
    if (error.response?.status === 429) {
      return res.status(429).json({ 
        error: "Límite de API excedido. Intenta nuevamente en unos minutos." 
      });
    }
    
    if (error.response?.status === 401) {
      return res.status(500).json({ 
        error: "Error de autenticación con OpenAI. Verifica la API key." 
      });
    }

    res.status(500).json({ 
      error: "Error creando prueba con IA",
      detalles: error.message 
    });
  }
});

// Helper: Descripción de niveles de dificultad
function getNivelDescription(nivel) {
  const descripciones = {
    basico: "Conceptos fundamentales, definiciones básicas, recordar información simple",
    intermedio: "Aplicación de conceptos, análisis de situaciones, comparar y contrastar",
    avanzado: "Síntesis de información compleja, evaluación crítica, resolución de problemas complejos"
  };
  return descripciones[nivel] || descripciones.intermedio;
}

// Obtener pruebas de un módulo
router.get("/modules/:moduleId/quizzes", async (req, res) => {
    try {
        const { moduleId } = req.params;
        const result = await db.execute(
            "SELECT * FROM pruebas_modulo WHERE id_modulo = ?", [moduleId]
        );
        const rows = result.rows || result[0];
        res.json(rows);
    } catch (error) {
        console.error("Error obteniendo pruebas:", error);
        res.status(500).json({ error: "Error obteniendo pruebas" });
    }
});

// Calcular nota de intento
async function calcularNota(respuestas, quizId) {
    const totalPreguntas = respuestas.length;

    if (totalPreguntas === 0) {
        return 0;
    }

    const respuestasPrueba = await db.execute(
        "SELECT preguntas FROM pruebas_modulo WHERE id = ?",
        [quizId]
    );

    const preguntasData = (respuestasPrueba.rows || respuestasPrueba[0])[0];
    if (!preguntasData) {
        throw new Error("Prueba no encontrada");
    }

    let preguntas;
    try {
        const raw = preguntasData.preguntas;
        if (Array.isArray(raw)) {
            preguntas = raw;
        } else if (typeof raw === "string") {
            // primer parse
            let parsed = JSON.parse(raw);
            // si queda string, intentar parse de nuevo (doble-escaped)
            if (typeof parsed === "string") {
                parsed = JSON.parse(parsed);
            }
            preguntas = Array.isArray(parsed) ? parsed : [];
        } else {
            preguntas = [];
        }
    } catch (err) {
        console.error("Error parsing preguntas in calcularNota:", err);
        preguntas = [];
    }

    let respuestasCorrectas = 0;

    preguntas.forEach((pregunta, index) => {
        // Normalizar a number por si llegan strings
        const correcta = Number(pregunta.respuestaCorrecta ?? pregunta.respuesta_correcta);
        const respuestaUsuario = Number(respuestas[index]);
        if (Number.isFinite(correcta) && respuestaUsuario === correcta) {
            respuestasCorrectas++;
        }
    });

    return (respuestasCorrectas / totalPreguntas) * 10;
}

// Registrar intento de prueba
router.post("/modules/:moduleId/quizzes/:quizId/attempts", async (req, res) => {
    const { moduleId, quizId } = req.params;
    const { userId, respuestas } = req.body;

    try {
        // Get previous attempts
        const [prevAttempts] = await db.execute(
            "SELECT nota FROM intentos_prueba WHERE id_prueba = ? AND id_usuario = ? ORDER BY nota DESC LIMIT 1",
            [quizId, userId]
        );
        
        const notaPrevia = prevAttempts[0]?.nota || null;
        
        // Calculate new grade
        const nota = await calcularNota(respuestas, quizId);
        
        // Get minimum passing grade
        const [pruebaData] = await db.execute(
            "SELECT nota_minima FROM pruebas_modulo WHERE id = ?",
            [quizId]
        );
        const notaMinima = pruebaData[0]?.nota_minima || 7;
        const aprobado = nota >= notaMinima;

        // Register attempt
        await db.execute(
            "INSERT INTO intentos_prueba (id_prueba, id_usuario, nota, aprobado) VALUES (?, ?, ?, ?)",
            [quizId, userId, nota, aprobado]
        );

        res.json({ 
            success: true, 
            nota,
            notaPrevia,
            aprobado
        });

    } catch (error) {
        console.error("Error insertando intento de prueba:", error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Obtener intentos de un usuario en una prueba
router.get("/modules/:moduleId/quizzes/:quizId/attempts/:userId", async (req, res) => {
    const { quizId, userId } = req.params;
    try {
        const result = await db.execute(
            "SELECT * FROM intentos_prueba WHERE id_prueba = ? AND id_usuario = ? ORDER BY nota DESC",
            [quizId, userId]
        );
        const rows = result.rows || result[0];
        const nota_maxima = rows.length > 0 ? rows[0].nota : null;
        res.json({ intentos: rows, nota_maxima });
    } catch (error) {
        console.error("Error obteniendo intento de prueba:", error);
        res.status(500).json({ error: "Error obteniendo intento de prueba" });
    }
});

router.get("/courses/:courseId/progress/:userId", async (req, res) => {
    const { courseId, userId } = req.params;
    try {
        const result = await db.execute(
            "SELECT * FROM progreso_modulo WHERE id_curso = ? AND id_usuario = ?",
            [courseId, userId]
        );
        const rows = result.rows || result[0];
        res.json(rows[0] || {});
    } catch (error) {
        console.error("Error obteniendo progreso:", error);
        res.status(500).json({ error: "Error obteniendo progreso" });
    }
});

router.put("/modules/:moduleId/quizzes/:quizId", async (req, res) => {
    const { moduleId, quizId } = req.params;
    const { nota_minima, preguntas } = req.body;
    try {
        // Evitar double-stringify al actualizar
        const preguntasToStore = typeof preguntas === "string" ? preguntas : JSON.stringify(preguntas);
        await db.execute(
            "UPDATE pruebas_modulo SET nota_minima = ?, preguntas = ? WHERE id = ? AND id_modulo = ?",
            [nota_minima, preguntasToStore, quizId, moduleId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Error actualizando prueba:", error);
        res.status(500).json({ error: "Error actualizando prueba" });
    }
});

router.post("/courses/:courseId/progress", async (req, res) => {
    const { courseId } = req.params;
    const { id_usuario, id_modulo_actual, nota_maxima } = req.body;

    try {
        // 1. Verificar si existe progreso previo
        const [progresoActual] = await db.execute(
            "SELECT * FROM progreso_modulo WHERE id_usuario = ? AND id_curso = ?",
            [id_usuario, courseId]
        );
        
        const progresoPrevio = (progresoActual.rows || progresoActual[0] || [])[0];

        // 2. Si no hay progreso previo, crear nuevo
        if (!progresoPrevio) {
            await db.execute(
                "INSERT INTO progreso_modulo (id_usuario, id_curso, id_modulo_actual, nota_maxima) VALUES (?, ?, ?, ?)",
                [id_usuario, courseId, id_modulo_actual, nota_maxima]
            );
            return res.json({ success: true, action: "created" });
        }

        // 3. Si hay progreso previo, solo actualizar si el nuevo módulo es el siguiente
        const [moduloInfo] = await db.execute(
            "SELECT orden FROM modulos WHERE id = ?",
            [progresoPrevio.id_modulo_actual]
        );
        
        const ordenActual = (moduloInfo.rows || moduloInfo[0] || [])[0]?.orden;

        // 4. Verificar orden del nuevo módulo
        const [nuevoModuloInfo] = await db.execute(
            "SELECT orden FROM modulos WHERE id = ?",
            [id_modulo_actual]
        );
        
        const ordenNuevo = (nuevoModuloInfo.rows || nuevoModuloInfo[0] || [])[0]?.orden;

        // 5. Solo actualizar si el nuevo módulo es el siguiente en orden
        if (ordenNuevo && ordenActual && ordenNuevo === ordenActual + 1) {
            await db.execute(
                "UPDATE progreso_modulo SET id_modulo_actual = ?, nota_maxima = ? WHERE id_usuario = ? AND id_curso = ?",
                [id_modulo_actual, nota_maxima, id_usuario, courseId]
            );
            return res.json({ success: true, action: "updated" });
        }

        // 6. Si no cumple las condiciones, mantener el progreso actual
        res.json({ 
            success: true, 
            action: "unchanged",
            message: "No se actualizó el progreso porque no es el siguiente módulo en orden" 
        });

    } catch (error) {
        console.error("Error actualizando progreso:", error);
        res.status(500).json({ error: "Error actualizando progreso" });
    }
});

module.exports = router;