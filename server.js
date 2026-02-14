const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN
});

// ============================================
// RATE LIMITING - Sin dependencias externas
// ============================================
const requestCounts = new Map();
const LIMITE_REQUESTS = 60;  // máximo requests por minuto por IP
const LIMITE_POSTS = 5;       // máximo posts por minuto por IP
const postCounts = new Map();

function limpiarContadores() {
    const ahora = Date.now();
    for (const [ip, data] of requestCounts.entries()) {
        if (ahora - data.inicio > 60000) requestCounts.delete(ip);
    }
    for (const [ip, data] of postCounts.entries()) {
        if (ahora - data.inicio > 60000) postCounts.delete(ip);
    }
}
setInterval(limpiarContadores, 60000);

function rateLimitGeneral(req, res, next) {
    const ip = req.headers['cf-connecting-ip'] || req.ip;
    const ahora = Date.now();
    const data = requestCounts.get(ip) || { count: 0, inicio: ahora };
    if (ahora - data.inicio > 60000) { data.count = 0; data.inicio = ahora; }
    data.count++;
    requestCounts.set(ip, data);
    if (data.count > LIMITE_REQUESTS) {
        return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento.' });
    }
    next();
}

function rateLimitPost(req, res, next) {
    const ip = req.headers['cf-connecting-ip'] || req.ip;
    const ahora = Date.now();
    const data = postCounts.get(ip) || { count: 0, inicio: ahora };
    if (ahora - data.inicio > 60000) { data.count = 0; data.inicio = ahora; }
    data.count++;
    postCounts.set(ip, data);
    if (data.count > LIMITE_POSTS) {
        return res.status(429).json({ error: 'Demasiados posts. Esperá un momento.' });
    }
    next();
}

// ============================================
// MIDDLEWARE DE SEGURIDAD - SOLO CLOUDFLARE
// ============================================
app.set('trust proxy', true);

app.use((req, res, next) => {
    const cfIP = req.headers['cf-connecting-ip'];
    const cfRay = req.headers['cf-ray'];
    const host = req.get('host') || '';
    
    // Permitir localhost en desarrollo
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
        return next();
    }
    
    // Bloquear si NO viene de Cloudflare
    if (!cfIP || !cfRay) {
        console.log(`🚫 Acceso bloqueado - Host: ${host}`);
        return res.status(403).send('Acceso denegado - Solo disponible via poste.ar');
    }
    
    next();
});

app.use(rateLimitGeneral);

// ============================================
// FUNCIONES DE FECHA Y PURGA
// ============================================
function obtenerFechaArgentina() {
    const ahora = new Date();
    const offsetArgentina = -3 * 60;
    const offsetLocal = ahora.getTimezoneOffset();
    const diffMinutos = offsetArgentina - offsetLocal;
    const fechaArgentina = new Date(ahora.getTime() + diffMinutos * 60 * 1000);
    return fechaArgentina.toISOString().slice(0, 19).replace('T', ' ');
}

function esLunesCeroHoras() {
    const ahora = new Date();
    const offsetArgentina = -3 * 60;
    const offsetLocal = ahora.getTimezoneOffset();
    const diffMinutos = offsetArgentina - offsetLocal;
    const fechaArgentina = new Date(ahora.getTime() + diffMinutos * 60 * 1000);
    return fechaArgentina.getDay() === 1 && fechaArgentina.getHours() === 0 && fechaArgentina.getMinutes() < 5;
}

async function purgarBaseDeDatos() {
    try {
        await db.execute("DELETE FROM posteos");
        console.log('✓ Base de datos purgada - Lunes 00:00 Argentina');
    } catch(e) {
        console.error('Error al purgar base de datos:', e);
    }
}

setInterval(async () => {
    if(esLunesCeroHoras()) await purgarBaseDeDatos();
}, 5 * 60 * 1000);

// ============================================
// MIDDLEWARE GENERAL
// ============================================
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

// ============================================
// RUTAS API
// ============================================
app.get('/api/posts', async (req, res) => {
    try {
        const rs = await db.execute("SELECT * FROM posteos ORDER BY id DESC LIMIT 50");
        res.json(Array.from(rs.rows));
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Error interno' }); 
    }
});

app.get('/api/buscar', async (req, res) => {
    try {
        const query = (req.query.q || '').slice(0, 100); // máximo 100 chars en búsqueda
        if (!query.trim()) {
            const rs = await db.execute("SELECT * FROM posteos ORDER BY id DESC LIMIT 50");
            return res.json(Array.from(rs.rows));
        }

        const terminos = query.split(',').map(t => t.trim()).filter(t => t).slice(0, 5); // máximo 5 términos
        
        let sql = "SELECT * FROM posteos WHERE ";
        const conditions = [];
        const args = [];
        
        terminos.forEach(termino => {
            conditions.push("(LOWER(etiqueta) LIKE ? OR LOWER(contenido) LIKE ? OR LOWER(fecha) LIKE ?)");
            const searchTerm = `%${termino.toLowerCase()}%`;
            args.push(searchTerm, searchTerm, searchTerm);
        });
        
        sql += conditions.join(' AND ') + " ORDER BY id DESC";
        
        const rs = await db.execute({ sql, args });
        res.json(Array.from(rs.rows));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/postear', rateLimitPost, async (req, res) => {
    let { etiqueta, contenido, color, semilla, contenido_oculto } = req.body;
    
    // Validación de campos obligatorios
    if (!etiqueta || !contenido) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    // Validación de longitud server-side
    if (etiqueta.length > 50) return res.status(400).json({ error: 'Etiqueta demasiado larga' });
    if (contenido.length > 600) return res.status(400).json({ error: 'Contenido demasiado largo' });
    if (contenido_oculto && contenido_oculto.length > 2000) return res.status(400).json({ error: 'Contenido oculto demasiado largo' });
    
    try {
        const fechaArgentina = obtenerFechaArgentina();
        await db.execute({
            sql: "INSERT INTO posteos (etiqueta, contenido, color, semilla, contenido_oculto, fecha) VALUES (?, ?, ?, ?, ?, ?)",
            args: [etiqueta, contenido, color || '#000000', semilla || null, contenido_oculto || null, fechaArgentina]
        });
        res.sendStatus(201);
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Error interno' }); 
    }
});

app.get('/source', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'source.txt'));
});

app.get('/keep-alive', (req, res) => res.send('ok'));

app.listen(PORT, () => { 
    console.log(`🚀 Servidor en puerto ${PORT}`); 
    console.log('🔒 Protección Cloudflare activada - Solo acceso via poste.ar');
    console.log('⏰ Purga automática configurada para lunes 00:00 Argentina');
});
