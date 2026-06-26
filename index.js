const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
require('dotenv').config();
const pool = require('./db');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 📧 CONFIGURACIÓN DE CORREO
// ==========================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'colegiodefebrero0@gmail.com', 
        pass: 'lntjlwjqfgkxnujn'
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
        console.log("✅ Factura enviada exitosamente a " + correoDestino);
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
    }
};

app.use(express.json());
app.use(express.static('public'));

// ==========================================
// ⚙️ INICIALIZAR AJUSTES
// ==========================================
(async function initAjustes() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ajustes (clave VARCHAR PRIMARY KEY, valor VARCHAR);`);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['precio_mensualidad', '60.00']);
    const defaultAdminKey = process.env.ADMIN_KEY || 'mi_clave_admin_123';
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['admin_key', defaultAdminKey]);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['price_change_key', 'admin123']);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['tasa_bs', '45.00']);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['tasa_pesos', '3900']);
    console.log('✅ Tabla ajustes inicializada');
    
    try { await pool.query(`ALTER TABLE pagos ALTER COLUMN mes_pagado TYPE TEXT;`); } catch(e) {}
    try { await pool.query(`ALTER TABLE alumnos ADD COLUMN IF NOT EXISTS cedula VARCHAR;`); } catch(e) {}
  } catch (err) { console.error('❌ Error inicializando ajustes:', err); }
})();

// ==========================================
// 📸 CONFIGURACIÓN DE MULTER
// ==========================================
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, 'public/uploads/'); },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const extension = path.extname(file.originalname);
    cb(null, `capture-${timestamp}${extension}`);
  }
});
const upload = multer({ storage: storage });

app.get('/', (req, res) => { res.send('Servidor funcionando correctamente 🚀'); });

// ==========================================
// 📝 RUTA: REGISTRO DE USUARIOS
// ==========================================
app.post('/api/registro', async (req, res) => {
  const { nombre_completo, cedula, correo, contrasena, alumnos } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const salt = await bcrypt.genSalt(10);
    const contrasenaEncriptada = await bcrypt.hash(contrasena, salt);
    const queryUsuario = `INSERT INTO usuarios (nombre_completo, cedula, correo, contrasena, rol, estatus) VALUES ($1, $2, $3, $4, 'representante', 'pendiente') RETURNING id;`;
    const resUsuario = await client.query(queryUsuario, [nombre_completo, cedula, correo, contrasenaEncriptada]);
    const representanteId = resUsuario.rows[0].id;

    if (alumnos && alumnos.length > 0) {
      for (let alumno of alumnos) {
        const queryAlumno = `INSERT INTO alumnos (nombre_completo, nivel, mencion, cedula, representante_id) VALUES ($1, $2, $3, $4, $5);`;
        const nivelAlumno = alumno.nivel || '';
        const isGrado = /Grado/i.test(nivelAlumno);
        const mencionAlumno = isGrado ? (alumno.seccion || '') : (alumno.mencion || '');
        const cedulaAlumno = alumno.cedula_alumno || alumno.cedula || null;
        await client.query(queryAlumno, [alumno.nombre_completo, nivelAlumno, mencionAlumno, cedulaAlumno, representanteId]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, mensaje: 'Usuario registrado con éxito. Pendiente por aprobación.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    if (error.code === '23505') return res.status(400).json({ ok: false, mensaje: 'La cédula o correo ya existen.' });
    res.status(500).json({ ok: false, mensaje: 'Error al registrar.' });
  } finally { client.release(); }
});

// ==========================================
// 🔑 RUTA: LOGIN
// ==========================================
app.post('/api/login', async (req, res) => {
  const { correo, contrasena } = req.body;
  try {
    const query = 'SELECT * FROM usuarios WHERE correo = $1;';
    const resultado = await pool.query(query, [correo]);
    if (resultado.rows.length === 0) return res.status(400).json({ ok: false, mensaje: 'Credenciales incorrectas.' });
    const usuario = resultado.rows[0];
    const contrasenaValida = await bcrypt.compare(contrasena, usuario.contrasena);
    if (!contrasenaValida) return res.status(400).json({ ok: false, mensaje: 'Credenciales incorrectas.' });
    if (usuario.estatus === 'pendiente') return res.status(403).json({ ok: false, mensaje: 'Tu cuenta está pendiente de aprobación.' });
    res.json({ ok: true, mensaje: '¡Bienvenido!', usuario: { id: usuario.id, nombre: usuario.nombre_completo, rol: usuario.rol } });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error en el login.' }); }
});

app.get('/api/representante/alumnos/:id', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM alumnos WHERE representante_id = $1;', [req.params.id]);
    res.json({ ok: true, alumnos: resultado.rows });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error al obtener alumnos.' }); }
});

app.post('/api/representante/pagos', upload.single('comprobante'), async (req, res) => {
  const { mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, representante_id } = req.body;
  const comprobanteNombre = req.file ? req.file.filename : null;
  try {
    const query = `INSERT INTO pagos (mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, estatus_pago, comprobante, representante_id) VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', $7, $8);`;
    await pool.query(query, [mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, comprobanteNombre, representante_id]);
    res.status(201).json({ ok: true, mensaje: 'Pago reportado con éxito.' });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error al procesar el pago.' }); }
});

app.post('/api/pagos/reportar', async (req, res) => {
  try {
    const { representante_id, mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, comprobante } = req.body;
    const comprobanteNombre = comprobante || 'efectivo_taquilla.png';
    const query = `INSERT INTO pagos (mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, estatus_pago, comprobante, representante_id) VALUES ($1, $2, $3, $4, $5, $6, 'aprobado', $7, $8);`;
    await pool.query(query, [mes_pagado, monto, moneda, referencia, (banco_origen || ''), (banco_destino || ''), comprobanteNombre, representante_id]);
    res.status(201).json({ ok: true, mensaje: 'Pago registrado manualmente.' });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error al registrar pago manual.' }); }
});

app.get('/api/admin/usuarios', async (req, res) => {
  try {
    const query = `SELECT u.id, u.nombre_completo, u.cedula, u.correo, u.rol, u.estatus, COALESCE(json_agg(json_build_object('nombre', a.nombre_completo, 'nivel', a.nivel, 'mencion', a.mencion, 'cedula', a.cedula)) FILTER (WHERE a.id IS NOT NULL), '[]') as alumnos FROM usuarios u LEFT JOIN alumnos a ON u.id = a.representante_id GROUP BY u.id ORDER BY u.id DESC;`;
    const resultado = await pool.query(query);
    res.json({ ok: true, usuarios: resultado.rows });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error.' }); }
});

app.put('/api/admin/usuarios/:id/estatus', async (req, res) => {
  try {
    await pool.query('UPDATE usuarios SET estatus = $1 WHERE id = $2;', [req.body.estatus, req.params.id]);
    res.json({ ok: true, mensaje: `Usuario aprobado.` });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error.' }); }
});

app.get('/api/admin/pagos', async (req, res) => {
  try {
    const query = `SELECT p.*, u.nombre_completo as representante_nombre, u.cedula as representante_cedula FROM pagos p JOIN usuarios u ON p.representante_id = u.id ORDER BY p.id DESC;`;
    const resultado = await pool.query(query);
    res.json({ ok: true, pagos: resultado.rows });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error.' }); }
});
// ==========================================
// 🗑️ RUTA ADMIN: ELIMINAR USUARIO Y SUS DATOS
// ==========================================
app.delete('/api/admin/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        // 1. Borramos primero los alumnos asociados al representante
        await client.query('DELETE FROM alumnos WHERE representante_id = $1', [id]);
        
        // 2. Borramos los pagos asociados al representante
        await client.query('DELETE FROM pagos WHERE representante_id = $1', [id]);
        
        // 3. Finalmente, borramos al representante de la tabla usuarios
        const result = await client.query('DELETE FROM usuarios WHERE id = $1', [id]);
        
        if (result.rowCount === 0) {
            throw new Error('Usuario no encontrado');
        }

        await client.query('COMMIT');
        res.json({ ok: true, mensaje: 'Usuario y sus datos eliminados.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al eliminar usuario:", error);
        res.status(500).json({ ok: false, mensaje: 'Error al eliminar usuario.' });
    } finally {
        client.release();
    }
});
// ==========================================
// 🔄 RUTA ADMIN: APROBAR O RECHAZAR PAGO (LA ÚNICA Y CORRECTA)
// ==========================================
app.put('/api/admin/pagos/:id/estatus', async (req, res) => {
    const { id } = req.params;
    const { estatus_pago, mensaje_rechazo } = req.body;

    try {
        await pool.query("ALTER TABLE pagos ADD COLUMN IF NOT EXISTS mensaje_rechazo TEXT;");
        await pool.query('UPDATE pagos SET estatus_pago = $1, mensaje_rechazo = $2 WHERE id = $3', [estatus_pago, mensaje_rechazo || null, id]);
        
        if (estatus_pago === 'aprobado') {
            const result = await pool.query('SELECT u.correo FROM usuarios u JOIN pagos p ON p.representante_id = u.id WHERE p.id = $1', [id]);
            
            if (result.rows.length > 0) {
                const pagoData = await pool.query('SELECT monto, moneda, referencia FROM pagos WHERE id = $1', [id]);
                enviarFacturaEmail(result.rows[0].correo, pagoData.rows[0]);
            }
        }
        res.json({ ok: true, mensaje: `Pago marcado como ${estatus_pago}` });
    } catch (error) {
        console.error("Error al actualizar pago:", error);
        res.status(500).json({ ok: false, mensaje: 'Error al actualizar.' });
    }
});

app.get('/api/representante/historial-pagos/:id', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM pagos WHERE representante_id = $1 ORDER BY id DESC;', [req.params.id]);
    res.json({ ok: true, pagos: resultado.rows });
  } catch (error) { res.status(500).json({ ok: false, mensaje: 'Error.' }); }
});

app.get('/api/health', async (req, res) => {
  try {
    const usuarios = await pool.query('SELECT COUNT(*)::int as count FROM usuarios;');
    const alumnos = await pool.query('SELECT COUNT(*)::int as count FROM alumnos;');
    const pagos = await pool.query('SELECT COUNT(*)::int as count FROM pagos;');
    res.json({ ok: true, counts: { usuarios: usuarios.rows[0].count, alumnos: alumnos.rows[0].count, pagos: pagos.rows[0].count } });
  } catch (error) { res.status(500).json({ ok: false }); }
});

// ========================================================
// RUTA SECRETA MAESTRA
// ========================================================
app.get('/inicializar-sistema-12febrero', async (req, res) => {
    try {
        const bcrypt = require('bcryptjs');
        const claveEncriptada = await bcrypt.hash('admin123', 10);
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nombre_completo VARCHAR(150), nombre VARCHAR(150), cedula VARCHAR(50), correo VARCHAR(100) UNIQUE NOT NULL, email VARCHAR(100) UNIQUE, clave VARCHAR(100), password VARCHAR(100), contrasena VARCHAR(100), rol VARCHAR(20) NOT NULL DEFAULT 'representante', estatus VARCHAR(20) NOT NULL DEFAULT 'activo');`);
        await pool.query(`CREATE TABLE IF NOT EXISTS alumnos (id SERIAL PRIMARY KEY, usuario_id INT, representante_id INT, nombre_completo VARCHAR(150), nombre VARCHAR(150), cedula VARCHAR(50), cedula_alumno VARCHAR(50), nivel VARCHAR(50), seccion VARCHAR(20), mencion VARCHAR(50));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS pagos (id SERIAL PRIMARY KEY, usuario_id INT, representante_id INT, representante_nombre VARCHAR(150), mes_pagado TEXT, monto VARCHAR(50), moneda VARCHAR(20), referencia VARCHAR(100), banco_origen VARCHAR(100), banco_destino VARCHAR(100), comprobante VARCHAR(255), estatus_pago VARCHAR(50) DEFAULT 'pendiente', mensaje_rechazo TEXT);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ajustes (clave VARCHAR(50) UNIQUE NOT NULL, valor VARCHAR(50) NOT NULL);`);
        await pool.query(`TRUNCATE TABLE pagos, alumnos, usuarios, ajustes RESTART IDENTITY CASCADE;`);
        await pool.query(`INSERT INTO usuarios (nombre_completo, nombre, cedula, correo, email, clave, password, contrasena, rol, estatus) VALUES ('Administrador General', 'Administrador General', 'V-00000000', 'admin@12febrero.com', 'admin@12febrero.com', '${claveEncriptada}', '${claveEncriptada}', '${claveEncriptada}', 'admin', 'activo');`);
        await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ('precio_mensualidad', '60.00'), ('tasa_bs', '45.00'), ('tasa_pesos', '3900');`);
        res.send(`<h1 style="color:#28a745;">🚀 Base de Datos Inicializada!</h1>`);
    } catch (error) { res.status(500).send("Error: " + error.message); }
});

app.get('/api/config', async (req, res) => {
  try {
    const qPrecio = await pool.query('SELECT valor FROM ajustes WHERE clave = $1;', ['precio_mensualidad']);
    const qBs = await pool.query('SELECT valor FROM ajustes WHERE clave = $1;', ['tasa_bs']);
    const qPesos = await pool.query('SELECT valor FROM ajustes WHERE clave = $1;', ['tasa_pesos']);
    res.json({ ok: true, precio: qPrecio.rows[0]?.valor, tasa_bs: qBs.rows[0]?.valor, tasa_pesos: qPesos.rows[0]?.valor });
  } catch (err) { res.status(500).json({ ok: false }); }
});

app.put('/api/config', async (req, res) => {
  try {
    const REQUIRED_KEY = process.env.ADMIN_KEY || 'mi_clave_admin_123';
    let provided = (req.headers['x-admin-key'] || req.headers['authorization'] || '').toString().replace('Bearer ', '').trim();
    if (provided !== REQUIRED_KEY) return res.status(403).json({ ok: false, mensaje: 'No autorizado' });

    const { precio, tasa_bs, tasa_pesos } = req.body;
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['precio_mensualidad', String(precio)]);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['tasa_bs', String(tasa_bs)]);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['tasa_pesos', String(tasa_pesos)]);
    res.json({ ok: true, mensaje: 'Configuración actualizada' });
  } catch (err) { res.status(500).json({ ok: false }); }
});

app.listen(PORT, () => { console.log(`🚀 Servidor corriendo en el puerto ${PORT}`); });
