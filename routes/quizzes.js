const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");

// Crear prueba final de módulo
router.post("/modules/:moduleId/quizzes", async (req, res) => {
    const { nota_minima, preguntas } = req.body;
    try {
        const moduleId = req.params.moduleId;
        await db.execute(
            "INSERT INTO pruebas_modulo (id_modulo, nota_minima, preguntas) VALUES (?, ?, ?)",
            [moduleId, nota_minima, JSON.stringify(preguntas)]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Error insertando prueba:", error);
        res.status(500).json({ error: "Error insertando prueba" });
    }
});

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

    const preguntas = JSON.parse(preguntasData.preguntas);
    let respuestasCorrectas = 0;

    preguntas.forEach((pregunta, index) => {
        if (pregunta.respuestaCorrecta === respuestas[index]) {
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
        // Verificar existencia de la prueba
        const nota_minima_result = await db.execute(
            "SELECT nota_minima FROM pruebas_modulo WHERE id = ? AND id_modulo = ?", 
            [quizId, moduleId]
        );

        const notaMinimaRow = (nota_minima_result.rows || nota_minima_result[0])[0];
        if (!notaMinimaRow) {
            return res.status(404).json({ error: "Prueba no encontrada" });
        }

        const nota = await calcularNota(respuestas, quizId);
        const aprobado = nota >= notaMinimaRow.nota_minima ? 1 : 0;

        await db.execute(
            "INSERT INTO intentos_prueba (id_prueba, id_usuario, nota, aprobado) VALUES (?, ?, ?, ?)",
            [quizId, userId, nota, aprobado]
        );

        res.json({ success: true, nota, aprobado });
    } catch (error) {
        console.error("Error insertando intento de prueba:", error);
        res.status(500).json({ error: "Error insertando intento de prueba" });
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
        await db.execute(
            "UPDATE pruebas_modulo SET nota_minima = ?, preguntas = ? WHERE id = ? AND id_modulo = ?",
            [nota_minima, JSON.stringify(preguntas), quizId, moduleId]
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
    const moduloAnterior = await db.execute(
        "SELECT * FROM progreso_modulo WHERE id_usuario = ? AND id_curso = ?",
        [id_usuario, courseId]
    );
    try {
        const progresoPrevio = moduloAnterior.rows[0];

        if (!progresoPrevio || progresoPrevio.id_modulo_actual < id_modulo_actual) {
            await db.execute(
                `INSERT INTO progreso_modulo (id_usuario, id_curso, id_modulo_actual, nota_maxima, fecha_actualizacion)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id_usuario, id_curso) DO UPDATE SET
                id_modulo_actual = excluded.id_modulo_actual,
                nota_maxima = CASE WHEN excluded.nota_maxima > progreso_modulo.nota_maxima THEN excluded.nota_maxima ELSE progreso_modulo.nota_maxima END,
                fecha_actualizacion = CURRENT_TIMESTAMP;`,
                [id_usuario, courseId, id_modulo_actual, nota_maxima]
            );
        }
        res.json({ success: true });
    } catch (error) {
        console.error("Error actualizando progreso:", error);
        res.status(500).json({ error: "Error actualizando progreso" });
    }
});

module.exports = router;