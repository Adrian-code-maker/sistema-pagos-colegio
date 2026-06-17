const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
require('dotenv').config();
const pool = require('./db');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'colegiodefebrero0@gmail.com',
        pass: 'lntj lwjq fgkx nujn'
    }
});

const enviarFacturaEmail = async (correoDestino, datosPago) => {
    try {
        await transporter.sendMail({
            from: '"Control Pagos 12 de Febrero" <colegiodefebrero0@gmail.com>',
            to: correoDestino,
            subject: "🧾 Factura Digital - Pago Aprobado",
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ccc; border-radius: 10px;">
                    <h2 style="color: #1e3a8a;">U.E. 12 de Febrero</h2>
                    <p>Estimado representante, su pago de <b>${datosPago.moneda} ${datosPago.monto}</b> ha sido aprobado exitosamente.</p>
                    <p>Referencia: ${datosPago.referencia}</p>
                    <p>¡Gracias por su puntualidad!</p>
                </div>`
        });
    } catch (error) { console.error("Error enviando correo:", error); }
};

// Inicialización de base de datos
(async function initAjustes() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS ajustes (clave VARCHAR PRIMARY KEY, valor VARCHAR);`);
        await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['precio_mensualidad', '60.00']);
        await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['admin_key', process.env.ADMIN_KEY || 'mi_clave_admin_123']);
        await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['tasa_bs', '45.00']);
        await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['tasa_pesos', '3900']);
    } catch (err) { console.error('Error inicializando ajustes:', err); }
})();

const storage = multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => { cb(null, `capture-${Date.now()}${path.extname(file.originalname)}`); }
});
const upload = multer({ storage: storage });

// --- RUTAS ---

app.get('/', (req, res) => res.send('Servidor funcionando 🚀'));

// Ruta Registro (Corregida)
app.post('/api/registro', async (req, res) => {
    const { nombre_completo, cedula, correo, contrasena, alumnos } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const salt = await bcrypt.genSalt(10);
        const contrasenaEncriptada = await bcrypt.hash(contrasena, salt);
        const resUsuario = await client.query(
            'INSERT INTO usuarios (nombre_completo, cedula, correo, contrasena, rol, estatus) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id;',
            [nombre_completo, cedula, correo, contrasenaEncriptada, 'representante', 'pendiente']
        );
        const representanteId = resUsuario.rows[0].id;
        for (let alumno of alumnos) {
            const isGrado = /Grado/i.test(alumno.nivel);
            await client.query(
                'INSERT INTO alumnos (nombre_completo, nivel, mencion, cedula, representante_id) VALUES ($1, $2, $3, $4, $5);',
                [alumno.nombre_completo, alumno.nivel, isGrado ? alumno.seccion : alumno.mencion, alumno.cedula_alumno || alumno.cedula, representanteId]
            );
        }
        await client.query('COMMIT');
        res.status(201).json({ ok: true, mensaje: 'Usuario registrado.' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ ok: false, mensaje: 'Error al registrar.' });
    } finally { client.release(); }
});

app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    try {
        const resultado = await pool.query('SELECT * FROM usuarios WHERE correo = $1;', [correo]);
        if (resultado.rows.length === 0) return res.status(400).json({ ok: false, mensaje: 'Credenciales incorrectas.' });
        const usuario = resultado.rows[0];
        const valid = await bcrypt.compare(contrasena, usuario.contrasena);
        if (!valid || usuario.estatus === 'pendiente') return res.status(403).json({ ok: false, mensaje: 'Acceso denegado.' });
        res.json({ ok: true, usuario: { id: usuario.id, nombre: usuario.nombre_completo, rol: usuario.rol } });
    } catch (err) { res.status(500).json({ ok: false, mensaje: 'Error en login.' }); }
});

app.post('/api/representante/pagos', upload.single('comprobante'), async (req, res) => {
    const { mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, representante_id } = req.body;
    try {
        await pool.query('INSERT INTO pagos (mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, estatus_pago, comprobante, representante_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);',
        [mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, 'pendiente', req.file ? req.file.filename : null, representante_id]);
        res.status(201).json({ ok: true, mensaje: 'Pago reportado.' });
    } catch (err) { res.status(500).json({ ok: false, mensaje: 'Error al reportar.' }); }
});

app.get('/api/admin/pagos', async (req, res) => {
    try {
        const result = await pool.query('SELECT p.*, u.nombre_completo as representante_nombre FROM pagos p JOIN usuarios u ON p.representante_id = u.id ORDER BY p.id DESC;');
        res.json({ ok: true, pagos: result.rows });
    } catch (err) { res.status(500).json({ ok: false, mensaje: 'Error al obtener pagos.' }); }
});

app.put('/api/admin/pagos/:id/estatus', async (req, res) => {
    const { id } = req.params;
    const { estatus_pago, mensaje_rechazo } = req.body;
    try {
        await pool.query('UPDATE pagos SET estatus_pago = $1, mensaje_rechazo = $2 WHERE id = $3', [estatus_pago, mensaje_rechazo, id]);
        if (estatus_pago === 'aprobado') {
            const result = await pool.query('SELECT u.correo FROM usuarios u JOIN pagos p ON p.representante_id = u.id WHERE p.id = $1', [id]);
            if (result.rows.length > 0) {
                const pagoData = await pool.query('SELECT monto, moneda, referencia FROM pagos WHERE id = $1', [id]);
                enviarFacturaEmail(result.rows[0].correo, pagoData.rows[0]);
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
