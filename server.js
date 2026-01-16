const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const db = createClient({
  url: process.env.TURSO_URL || "libsql://ciudadeloa-db-andreottica.aws-us-east-1.turso.io",
  authToken: process.env.TURSO_TOKEN
});

app.use(express.json());
app.use(express.static('public'));

app.get('/api/posts', async (req, res) => {
    try {
        const rs = await db.execute("SELECT * FROM posteos ORDER BY id DESC LIMIT 50");
        res.json(Array.from(rs.rows));
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/api/postear', async (req, res) => {
    const { etiqueta, contenido, color, semilla, contenido_oculto } = req.body;
    
    if (!etiqueta || !contenido) {
        return res.status(400).json({ error: 'Faltan datos' });
    }
    
    try {
        await db.execute({
            sql: "INSERT INTO posteos (etiqueta, contenido, color, semilla, contenido_oculto) VALUES (?, ?, ?, ?, ?)",
            args: [etiqueta, contenido, color, semilla || null, contenido_oculto || null]
        });
        res.sendStatus(201);
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/source', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'source.txt'));
});

app.get('/api/stats', async (req, res) => {
    try {
        const count = await db.execute("SELECT COUNT(*) as total FROM posteos");
        const rows = Array.from(count.rows);
        const maxCapacity = 1000;
        const percentage = Math.floor((rows[0].total / maxCapacity) * 100);
        res.json({ 
            total: rows[0].total, 
            percentage,
            maxCapacity 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/keep-alive', (req, res) => res.send('ok'));

app.listen(PORT, () => { 
    console.log(`🚀 Servidor en puerto ${PORT}`); 
});
