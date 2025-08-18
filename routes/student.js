const express = require("express");
const router = express.Router();
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const jwt = require("jsonwebtoken");

router.get("/my-students/:courseId", async (req, res) => {
    const estudiantes = await db.execute(
        `SELECT 
            u.id,
            u.nombre,
            u.nombre_usuario,
            u.fotoPerfil,
            u.color_perfil,
            ROUND(SUM(n.valor_nota * (n.porcentaje / 100)), 2) AS promedio
        FROM usuarios u
        JOIN cursos_estudiante ce ON u.id = ce.idUsuario
        LEFT JOIN notas n 
            ON n.id_est = u.id 
            AND n.id_curso = ce.idCurso
        WHERE ce.idCurso = ?
        GROUP BY u.id, u.nombre, u.nombre_usuario, u.fotoPerfil, u.color_perfil`,
        [req.params.courseId]
    );

    return res.send(estudiantes.rows);
});

router.get("/myChats", async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    let userPayload;
    try {
        userPayload = jwt.verify(token, JWT_SECRET);
    } catch {
        return res.status(401).json({ error: "Token inválido" });
    }

    const listChats = await db.execute(
        `
        SELECT 
            cp.id AS conversacion_id,
            cp.fecha_creacion,
            cp.ultimo_mensaje,
            u.id AS participante_id,
            u.nombre AS participante_nombre,
            u.rol AS participante_rol,
            u.fotoPerfil,

            (
                SELECT json_group_array(c.nombre)
                FROM cursos c
                WHERE 
                    -- estudiante ∩ estudiante
                    (
                        EXISTS (
                            SELECT 1 FROM cursos_estudiante ce1
                            WHERE ce1.idUsuario = ?
                            AND ce1.idCurso = c.id
                        )
                        AND EXISTS (
                            SELECT 1 FROM cursos_estudiante ce2
                            WHERE ce2.idUsuario = u.id
                            AND ce2.idCurso = c.id
                        )
                    )

                    OR
                    -- yo admin ∩ otro estudiante
                    (
                        c.admin = ?
                        AND EXISTS (
                            SELECT 1 FROM cursos_estudiante ce3
                            WHERE ce3.idUsuario = u.id
                            AND ce3.idCurso = c.id
                        )
                    )

                    OR
                    -- yo estudiante ∩ otro admin
                    (
                        EXISTS (
                            SELECT 1 FROM cursos_estudiante ce4
                            WHERE ce4.idUsuario = ?
                            AND ce4.idCurso = c.id
                        )
                        AND c.admin = u.id
                    )

                    OR
                    -- admin ∩ admin
                    (c.admin = ? AND c.admin = u.id)
            ) AS cursos_en_comun

        FROM conversaciones_privadas cp
        JOIN participantes_conversacion pc
            ON cp.id = pc.conversacion_id
        JOIN usuarios u
            ON pc.usuario_id = u.id
        WHERE cp.id IN (
            SELECT conversacion_id
            FROM participantes_conversacion
            WHERE usuario_id = ?
        )
        AND u.id <> ?;
        `,
        [
            userPayload.id, // estudiante ∩ estudiante
            userPayload.id, // yo admin
            userPayload.id, // yo estudiante
            userPayload.id, // yo admin para admin ∩ admin
            userPayload.id, // para WHERE usuario_id
            userPayload.id  // excluir a mí mismo
        ]
    );

    res.json(listChats.rows);
});




module.exports = router;
