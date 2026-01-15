const express = require('express');
const { createClient } = require('@libsql/client');
const app = express();
const PORT = process.env.PORT || 3000;

const db = createClient({
  url: "libsql://ciudadeloa-db-andreottica.aws-us-east-1.turso.io",
  authToken: process.env.TURSO_TOKEN
});

app.use(express.json());
app.use(express.static('public')); 

app.get('/api/posts', async (req, res) => {
    try {
        const rs = await db.execute("SELECT * FROM posteos ORDER BY id DESC LIMIT 50");
        res.json(rs.rows);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/postear', async (req, res) => {
    const { etiqueta, contenido, color, semilla, contenido_oculto } = req.body;
    try {
        await db.execute({
            sql: "INSERT INTO posteos (etiqueta, contenido, color, semilla, contenido_oculto) VALUES (?, ?, ?, ?, ?)",
            args: [etiqueta, contenido, color, semilla, contenido_oculto]
        });
        res.sendStatus(201);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/keep-alive', (req, res) => res.send('ok'));

app.listen(PORT, () => { console.log(`Puerto: ${PORT}`); });
