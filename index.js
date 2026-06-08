const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
require('dotenv').config();
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
app.use(express.json());
app.use(express.static('public'));

// Inicializar tabla de ajustes si no existe y asegurar valor por defecto
(async function initAjustes() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ajustes (clave VARCHAR PRIMARY KEY, valor VARCHAR);`);
    // Insertar valor por defecto si no existe
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['precio_mensualidad', '60.00']);
    // Guardar claves por defecto en ajustes para permitir gestión dinámica
    const defaultAdminKey = process.env.ADMIN_KEY || 'mi_clave_admin_123';
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['admin_key', defaultAdminKey]);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['price_change_key', 'admin123']);
    // Tasas por defecto para conversiones multimoneda
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['tasa_bs', '45.00']);
    await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING;`, ['tasa_pesos', '3900']);
    console.log('✅ Tabla ajustes inicializada');
    if (!process.env.ADMIN_KEY) console.warn('⚠️ ADMIN_KEY no está configurada. PUT /api/config estará protegida y no se podrá usar hasta definir ADMIN_KEY en .env');
    // Asegurar que la columna mes_pagado en pagos soporta listas largas (TEXT)
    try {
      await pool.query(`ALTER TABLE pagos ALTER COLUMN mes_pagado TYPE TEXT;`);
      console.log('✅ Columna pagos.mes_pagado asegurada como TEXT');
    } catch(e) {
      // No hacemos fallar el init si la tabla/columna no existe aún
      console.warn('Nota: no se pudo alterar pagos.mes_pagado (tal vez la tabla no existe aún).', e.message);
    }
    // Asegurar que la tabla alumnos tenga la columna para cédula del alumno
    try {
      await pool.query(`ALTER TABLE alumnos ADD COLUMN IF NOT EXISTS cedula VARCHAR;`);
      console.log('✅ Columna alumnos.cedula asegurada');
    } catch(e) {
      console.warn('Nota: no se pudo asegurar alumnos.cedula (tal vez la tabla no existe aún).', e.message);
    }
  } catch (err) {
    console.error('❌ Error inicializando ajustes:', err);
  }
})();

// ==========================================
// 📸 CONFIGURACIÓN DE MULTER (SUBIR IMÁGENES)
// ==========================================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/'); // Carpeta donde se guardarán los captures
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const extension = path.extname(file.originalname);
    cb(null, `capture-${timestamp}${extension}`); // Ejemplo: capture-17154238.png
  }
});

const upload = multer({ storage: storage });

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente 🚀');
});

// Ruta: Registro
app.post('/api/registro', async (req, res) => {
  const { nombre_completo, cedula, correo, contrasena, alumnos } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const salt = await bcrypt.genSalt(10);
    const contrasenaEncriptada = await bcrypt.hash(contrasena, salt);
    const queryUsuario = `
      INSERT INTO usuarios (nombre_completo, cedula, correo, contrasena, rol, estatus)
      VALUES ($1, $2, $3, $4, 'representante', 'pendiente') RETURNING id;
    `;
    const resUsuario = await client.query(queryUsuario, [nombre_completo, cedula, correo, contrasenaEncriptada]);
    const representanteId = resUsuario.rows[0].id;

    if (alumnos && alumnos.length > 0) {
      for (let alumno of alumnos) {
        const queryAlumno = `
          INSERT INTO alumnos (nombre_completo, nivel, mencion, cedula, representante_id)
          VALUES ($1, $2, $3, $4, $5);
        `;
        const nivelAlumno = alumno.nivel || '';
        const isGrado = /Grado/i.test(nivelAlumno);
        // Validación estricta: si es Grado (Primaria) se requiere sección; si es Año (Técnica) se requiere mención
        if (isGrado) {
          if (!alumno.seccion || alumno.seccion === 'Ninguna') {
            throw new Error(`Falta la sección para el alumno ${alumno.nombre_completo || '(sin nombre)'}`);
          }
        } else {
          if (!alumno.mencion || alumno.mencion === 'Ninguna') {
            throw new Error(`Falta la mención para el alumno ${alumno.nombre_completo || '(sin nombre)'}`);
          }
        }
        const mencionAlumno = isGrado ? alumno.seccion : alumno.mencion;
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
    // Errores de validación detectados en servidor
    if (error.message && (error.message.startsWith('Falta la') || error.message.includes('sección') || error.message.includes('mención'))) {
      return res.status(400).json({ ok: false, mensaje: error.message });
    }
    res.status(500).json({ ok: false, mensaje: 'Error al registrar.' });
  } finally {
    client.release();
  }
});

// Ruta: Login
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
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, mensaje: 'Error en el login.' });
  }
});

// Ruta: Obtener Alumnos de un Representante
app.get('/api/representante/alumnos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const query = 'SELECT * FROM alumnos WHERE representante_id = $1;';
    const resultado = await pool.query(query, [id]);
    res.json({ ok: true, alumnos: resultado.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener alumnos.' });
  }
});

// ==========================================================
// 💰 RUTA ACTUALIZADA: REPORTAR PAGO CON MONEDA Y COMPROBANTE
// ==========================================================
app.post('/api/representante/pagos', upload.single('comprobante'), async (req, res) => {
  const { mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, representante_id } = req.body;
  
  // Guardamos el nombre del archivo de la imagen si fue subida correctamente
  const comprobanteNombre = req.file ? req.file.filename : null;

  try {
    const query = `
      INSERT INTO pagos (mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, estatus_pago, comprobante, representante_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', $7, $8);
    `;
    await pool.query(query, [mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, comprobanteNombre, representante_id]);
    
    res.status(201).json({ ok: true, mensaje: 'Pago y capture reportados con éxito. En espera de verificación.' });
  } catch (error) {
    console.error(error);
    if (error.code === '23505') {
      return res.status(400).json({ ok: false, mensaje: 'Este número de referencia ya se encuentra registrado.' });
    }
    res.status(500).json({ ok: false, mensaje: 'Error interno al procesar el reporte de pago.' });
  }
});

// Ruta: Registrar pago manual en taquilla (creado por admin desde panel)
app.post('/api/pagos/reportar', async (req, res) => {
  try {
    const { representante_id, mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, comprobante } = req.body;
    const comprobanteNombre = comprobante || 'efectivo_taquilla.png';
    const estatus = 'aprobado';

    const query = `
      INSERT INTO pagos (mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, estatus_pago, comprobante, representante_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
    `;
    try {
      await pool.query(query, [mes_pagado, monto, moneda, referencia, (banco_origen !== undefined ? banco_origen : ''), (banco_destino !== undefined ? banco_destino : ''), estatus, comprobanteNombre, representante_id]);
      res.status(201).json({ ok: true, mensaje: 'Pago registrado manualmente y aprobado.' });
    } catch (err) {
      console.error('Error en INSERT /api/pagos/reportar', err);
      return res.status(500).json({ ok: false, mensaje: 'Error al registrar pago manual.' });
    }
  } catch (error) {
    console.error('Error registrando pago manual', error);
    if (error.code === '23505') return res.status(400).json({ ok: false, mensaje: 'Este número de referencia ya se encuentra registrado.' });
    res.status(500).json({ ok: false, mensaje: 'Error al registrar pago manual.' });
  }
});

// Ruta Admin: Ver Usuarios
app.get('/api/admin/usuarios', async (req, res) => {
  try {
    const query = `
            SELECT u.id, u.nombre_completo, u.cedula, u.correo, u.rol, u.estatus,
              COALESCE(json_agg(json_build_object('nombre', a.nombre_completo, 'nivel', a.nivel, 'mencion', a.mencion, 'cedula', a.cedula)) FILTER (WHERE a.id IS NOT NULL), '[]') as alumnos
      FROM usuarios u LEFT JOIN alumnos a ON u.id = a.representante_id GROUP BY u.id ORDER BY u.id DESC;
    `;
    const resultado = await pool.query(query);
    res.json({ ok: true, usuarios: resultado.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener datos.' });
  }
});

// Ruta Admin: Aprobar
app.put('/api/admin/usuarios/:id/estatus', async (req, res) => {
  const { id } = req.params;
  const { estatus } = req.body;
  try {
    await pool.query('UPDATE usuarios SET estatus = $1 WHERE id = $2;', [estatus, id]);
    res.json({ ok: true, mensaje: `Usuario aprobado.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar.' });
  }
});
// ==========================================
// 📊 RUTA ADMIN: OBTENER TODOS LOS PAGOS
// ==========================================
app.get('/api/admin/pagos', async (req, res) => {
  try {
    const query = `
      SELECT p.*, u.nombre_completo as representante_nombre, u.cedula as representante_cedula
      FROM pagos p
      JOIN usuarios u ON p.representante_id = u.id
      ORDER BY p.id DESC;
    `;
    const resultado = await pool.query(query);
    res.json({ ok: true, pagos: resultado.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el listado de pagos.' });
  }
});

// ==========================================
// 🔄 RUTA ADMIN: APROBAR O RECHAZAR UN PAGO
// ==========================================
app.put('/api/admin/pagos/:id/estatus', async (req, res) => {
  const { id } = req.params;
  const { estatus_pago } = req.body; // Recibe 'aprobado' o 'rechazado'

  try {
    // Aseguramos que la columna para el mensaje de rechazo exista
    await pool.query("ALTER TABLE pagos ADD COLUMN IF NOT EXISTS mensaje_rechazo TEXT;");

    // Si se envía un mensaje de rechazo, lo guardamos junto al estatus
    const mensajeRechazo = req.body.mensaje_rechazo || null;
    const query = 'UPDATE pagos SET estatus_pago = $1, mensaje_rechazo = $2 WHERE id = $3;';
    await pool.query(query, [estatus_pago, mensajeRechazo, id]);
    res.json({ ok: true, mensaje: `El pago ha sido marcado como ${estatus_pago} con éxito.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar el estatus del pago.' });
  }
});
// ==========================================
// 📊 RUTA REPRESENTANTE: VER HISTORIAL DE PAGOS
// ==========================================
app.get('/api/representante/historial-pagos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const query = 'SELECT * FROM pagos WHERE representante_id = $1 ORDER BY id DESC;';
    const resultado = await pool.query(query, [id]);
    res.json({ ok: true, pagos: resultado.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener el historial de pagos.' });
  }
});

// Ruta de diagnóstico: devuelve conteos rápidos de tablas relevantes
app.get('/api/health', async (req, res) => {
  try {
    const usuarios = await pool.query('SELECT COUNT(*)::int as count FROM usuarios;');
    const alumnos = await pool.query('SELECT COUNT(*)::int as count FROM alumnos;');
    const pagos = await pool.query('SELECT COUNT(*)::int as count FROM pagos;');
    const ultimosPagos = await pool.query('SELECT id, representante_id, mes_pagado, monto, moneda, estatus_pago FROM pagos ORDER BY id DESC LIMIT 10;');
    res.json({ ok: true, counts: { usuarios: usuarios.rows[0].count, alumnos: alumnos.rows[0].count, pagos: pagos.rows[0].count }, ultimosPagos: ultimosPagos.rows });
  } catch (error) {
    console.error('Health check failed', error);
    res.status(500).json({ ok: false, mensaje: 'Error al ejecutar health check', error: error.message });
  }
});
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});

// ==============================
// RUTAS DE CONFIGURACIÓN
// ==============================
// Obtener configuración (precio de mensualidad)
app.get('/api/config', async (req, res) => {
  try {
    const qPrecio = await pool.query('SELECT valor FROM ajustes WHERE clave = $1;', ['precio_mensualidad']);
    const qBs = await pool.query('SELECT valor FROM ajustes WHERE clave = $1;', ['tasa_bs']);
    const qPesos = await pool.query('SELECT valor FROM ajustes WHERE clave = $1;', ['tasa_pesos']);
    const precio = qPrecio.rows.length ? qPrecio.rows[0].valor : null;
    const tasa_bs = qBs.rows.length ? qBs.rows[0].valor : null;
    const tasa_pesos = qPesos.rows.length ? qPesos.rows[0].valor : null;
    res.json({ ok: true, precio, tasa_bs, tasa_pesos });
  } catch (err) {
    console.error('Error obteniendo config', err);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener configuración' });
  }
});

// Actualizar configuración (solo admin) - protección mediante header 'x-admin-key' que debe igualar ADMIN_KEY en .env
app.put('/api/config', async (req, res) => {
  try {
    // Validación estricta: requiere cabecera X-Admin-Key o Authorization con la clave exacta 'mi_clave_admin_123'
    let provided = req.headers['x-admin-key'] || req.headers['authorization'] || '';
    if (typeof provided === 'string' && provided.toLowerCase().startsWith('bearer ')) provided = provided.slice(7).trim();
    provided = (provided || '').toString().trim();
    const REQUIRED_KEY = process.env.ADMIN_KEY || 'mi_clave_admin_123';
    if (provided !== REQUIRED_KEY) {
      console.warn('PUT /api/config - unauthorized attempt', { provided });
      return res.status(403).json({ ok: false, mensaje: 'No autorizado' });
    }

    const { precio, tasa_bs, tasa_pesos } = req.body;
    if (precio === undefined || tasa_bs === undefined || tasa_pesos === undefined) return res.status(400).json({ ok: false, mensaje: 'Faltan valores (precio, tasa_bs, tasa_pesos)' });

    // Actualizamos las tres claves de forma atómica
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['precio_mensualidad', String(precio)]);
      await client.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['tasa_bs', String(tasa_bs)]);
      await client.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['tasa_pesos', String(tasa_pesos)]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true, mensaje: 'Configuración actualizada', precio: String(precio), tasa_bs: String(tasa_bs), tasa_pesos: String(tasa_pesos) });
  } catch (err) {
    console.error('Error actualizando config', err);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar configuración' });
  }
});

// Endpoint para actualizar claves administrativas (admin_key y price_change_key)
app.put('/api/admin/keys', async (req, res) => {
  try {
    const provided = req.headers['x-admin-key'] || '';
    const qAdmin = await pool.query('SELECT valor FROM ajustes WHERE clave = $1;', ['admin_key']);
    const currentAdminKey = qAdmin.rows.length ? qAdmin.rows[0].valor : (process.env.ADMIN_KEY || '');
    if (!currentAdminKey || provided !== currentAdminKey) return res.status(403).json({ ok: false, mensaje: 'No autorizado' });

    const { admin_key, price_change_key } = req.body;
    if (admin_key) {
      await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['admin_key', String(admin_key)]);
    }
    if (price_change_key) {
      await pool.query(`INSERT INTO ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;`, ['price_change_key', String(price_change_key)]);
    }
    res.json({ ok: true, mensaje: 'Claves actualizadas' });
  } catch (err) {
    console.error('Error actualizando claves', err);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar claves' });
  }
});

// Cambiar contraseña de un usuario (se solicita la contraseña actual)
app.put('/api/usuarios/:id/password', async (req, res) => {
  const { id } = req.params;
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ ok: false, mensaje: 'Faltan datos' });
  if (String(new_password).length < 6) return res.status(400).json({ ok: false, mensaje: 'La nueva contraseña debe tener al menos 6 caracteres' });
  try {
    const q = await pool.query('SELECT contrasena FROM usuarios WHERE id = $1;', [id]);
    if (q.rows.length === 0) return res.status(404).json({ ok: false, mensaje: 'Usuario no encontrado' });
    const hashed = q.rows[0].contrasena;
    const valid = await bcrypt.compare(current_password, hashed);
    if (!valid) return res.status(403).json({ ok: false, mensaje: 'Contraseña actual incorrecta' });
    const salt = await bcrypt.genSalt(10);
    const nuevoHash = await bcrypt.hash(new_password, salt);
    await pool.query('UPDATE usuarios SET contrasena = $1 WHERE id = $2;', [nuevoHash, id]);
    res.json({ ok: true, mensaje: 'Contraseña actualizada' });
  } catch (err) {
    console.error('Error cambiando contraseña de usuario', err);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar contraseña' });
  }
});