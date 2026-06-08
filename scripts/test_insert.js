const pool = require('../db');
(async () => {
  try {
    const q = `INSERT INTO pagos (mes_pagado, monto, moneda, referencia, banco_origen, banco_destino, estatus_pago, comprobante, representante_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    const values = ['["Enero"]', '60', 'USD', 'test_manual_node_2', 'Efectivo - Taquilla', '', 'aprobado', 'efectivo_taquilla.png', 6];
    const res = await pool.query(q, values);
    console.log('INSERT OK', res.rowCount);
    process.exit(0);
  } catch (err) {
    console.error('INSERT ERROR', err);
    process.exit(1);
  }
})();