const express = require('express');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');

// ====================================================================
// FUNCIÓN: Reemplazo minimalista para uuidv4()
// ====================================================================
const generateSimpleId = () => {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
};

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());

// CORS básico (ajusta según necesites)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ====================================================================
// RUTA PARA EL CLIENTE CLI - OBTENER PEERS ACTIVOS
// ====================================================================
app.get('/peers', (req, res) => {
    const activePeers = [];
    const timeoutThreshold = 120000; // 2 minutos

    peers.forEach((peer, id) => {
        // Solo peers con puerto P2P definido, username identificado y activos
        if (peer.p2pPort && peer.username && (Date.now() - peer.lastSeen < timeoutThreshold)) {
            activePeers.push({
                username: peer.username,
                host: peer.ip,
                port: peer.p2pPort
            });
        }
    });

    res.json({ peers: activePeers });
});

// Servir archivos estáticos
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

// Crear servidor HTTP
const server = require('http').createServer(app);

// WebSocket para peers P2P
const wss = new WebSocket.Server({ server });

// Almacén de peers activos
// peerId -> { ws, ip, lastSeen, p2pPort, username }
const peers = new Map();

// Archivo de usuarios registrados
const USERS_FILE = path.join(__dirname, 'users.json');

// Almacén de usuarios
let registeredUsers = new Map();

// ====================================================================
// FUNCIONES PARA MANEJO DE USUARIOS
// ====================================================================
async function loadUsers() {
    try {
        const data = await fs.readFile(USERS_FILE, 'utf8');
        const users = JSON.parse(data);
        registeredUsers = new Map(Object.entries(users));
        console.log(`[USERS] ${registeredUsers.size} usuarios cargados`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[USERS] Archivo de usuarios no existe, creando nuevo...');
            await saveUsers();
        } else {
            console.error('[USERS] Error cargando usuarios:', error);
        }
    }
}

async function saveUsers() {
    try {
        const usersObject = Object.fromEntries(registeredUsers);
        await fs.writeFile(USERS_FILE, JSON.stringify(usersObject, null, 2), 'utf8');
    } catch (error) {
        console.error('[USERS] Error guardando usuarios:', error);
    }
}

// Función simple de hash (Para producción, usa bcrypt)
function simpleHash(password) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(password).digest('hex');
}

// ====================================================================
// RUTAS API REST - REGISTRO Y LOGIN
// ====================================================================
app.post('/register', async (req, res) => {
    const { username, password, publicKey } = req.body;

    // Validación de entrada
    if (!username || !password || !publicKey) {
        return res.status(400).json({ error: 'Faltan campos requeridos.' });
    }

    if (typeof username !== 'string' || typeof password !== 'string' || typeof publicKey !== 'string') {
        return res.status(400).json({ error: 'Los campos deben ser strings.' });
    }

    if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'El username debe tener entre 3 y 20 caracteres.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    if (registeredUsers.has(username)) {
        return res.status(409).json({ error: 'El nombre de usuario ya está registrado.' });
    }

    // Guardar con contraseña hasheada
    registeredUsers.set(username, {
        password: simpleHash(password),
        publicKey: publicKey
    });
    
    await saveUsers();

    console.log(`[REGISTER] Nuevo usuario registrado: ${username}`);
    res.status(200).json({ message: 'Usuario registrado exitosamente.', username });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    // Validación de entrada
    if (!username || !password) {
        return res.status(400).json({ error: 'Faltan campos requeridos.' });
    }

    const user = registeredUsers.get(username);

    if (user && user.password === simpleHash(password)) {
        console.log(`[LOGIN] Login exitoso: ${username}`);
        return res.status(200).json({
            message: 'Login exitoso.',
            username,
            publicKey: user.publicKey
        });
    } else {
        return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
});

// ====================================================================
// MANEJO DE CONEXIONES WEBSOCKET
// ====================================================================
wss.on('connection', (ws, req) => {
    const peerId = generateSimpleId();
    const clientIp = req.headers['x-forwarded-for'] 
        ? req.headers['x-forwarded-for'].split(',')[0].trim() 
        : req.socket.remoteAddress;

    // Inicializar peer sin puerto P2P ni username aún
    peers.set(peerId, {
        ws,
        ip: clientIp,
        lastSeen: Date.now(),
        p2pPort: null,
        username: null
    });

    console.log(`[+] Nuevo Peer conectado: ${peerId} - IP: ${clientIp} - Total: ${peers.size}`);

    // Notificar al nuevo peer su ID
    ws.send(JSON.stringify({
        type: 'YOUR_ID',
        peerId: peerId
    }));

    // Notificar a los demás peers
    peers.forEach((peer, id) => {
        if (id !== peerId && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(JSON.stringify({
                type: 'NEW_PEER',
                peerId: peerId
            }));
        }
    });

    // ====================================================================
    // MANEJO DE MENSAJES WEBSOCKET
    // ====================================================================
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const peer = peers.get(peerId);

            if (!peer) return;

            // Actualizar timestamp en cada mensaje
            peer.lastSeen = Date.now();

            // HEARTBEAT
            if (data.type === 'HEARTBEAT') {
                // Ya actualizado arriba
                return;
            }

            // IDENTIFICACIÓN DE USUARIO
            if (data.type === 'IDENTIFY' && data.username) {
                if (typeof data.username === 'string') {
                    peer.username = data.username;
                    console.log(`[IDENTIFY] Peer ${peerId} identificado como: ${data.username}`);
                }
                return;
            }

            // ACTUALIZACIÓN DE PUERTO P2P
            if (data.type === 'UPDATE_PORT' && data.p2pPort) {
                const port = parseInt(data.p2pPort);
                if (!isNaN(port) && port > 0 && port < 65536) {
                    peer.p2pPort = port;
                    console.log(`[UPDATE_PORT] Peer ${peerId} (@${peer.username || 'Unknown'}) actualizó puerto P2P a: ${port}`);
                }
                return;
            }

            // SEÑALES WEBRTC (Para cliente web)
            if (data.type === 'WEBRTC_OFFER' || data.type === 'WEBRTC_ANSWER' || data.type === 'ICE_CANDIDATE') {
                const targetPeer = peers.get(data.to);
                if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
                    data.from = peerId;
                    targetPeer.ws.send(JSON.stringify(data));
                }
                return;
            }

        } catch (err) {
            console.error(`[ERROR] Error procesando mensaje de ${peerId}:`, err);
        }
    });

    // ====================================================================
    // MANEJO DE DESCONEXIÓN
    // ====================================================================
    ws.on('close', () => {
        const peer = peers.get(peerId);
        const username = peer ? peer.username || 'Unknown' : 'Unknown';
        
        peers.delete(peerId);
        console.log(`[-] Peer desconectado: ${peerId} (@${username}) - Total: ${peers.size}`);

        // Notificar a los demás
        peers.forEach((p, id) => {
            if (p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(JSON.stringify({
                    type: 'PEER_LEFT',
                    peerId: peerId
                }));
            }
        });
    });

    // Manejo de errores en WebSocket
    ws.on('error', (error) => {
        console.error(`[WS ERROR] Error en conexión ${peerId}:`, error);
    });
});

// ====================================================================
// HEARTBEAT TIMEOUT CHECKER
// ====================================================================
setInterval(() => {
    const now = Date.now();
    const timeout = 90000; // 90 segundos

    peers.forEach((peer, id) => {
        if (now - peer.lastSeen > timeout) {
            const username = peer.username || 'Unknown';
            console.log(`[TIMEOUT] Peer inactivo eliminado: ${id} (@${username})`);

            // Notificar a otros peers
            peers.forEach((p, pid) => {
                if (pid !== id && p.ws.readyState === WebSocket.OPEN) {
                    p.ws.send(JSON.stringify({
                        type: 'PEER_LEFT',
                        peerId: id
                    }));
                }
            });

            // Cerrar conexión y eliminar
            if (peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.close();
            }
            peers.delete(id);
        }
    });
}, 30000); // Cada 30 segundos

// ====================================================================
// INICIAR SERVIDOR
// ====================================================================
loadUsers().then(() => {
    server.listen(PORT, () => {
        console.log(`[SERVER] Servidor corriendo en el puerto ${PORT}`);
        console.log(`[SERVER] WebSocket disponible para conexiones P2P`);
    });
}).catch(error => {
    console.error('[SERVER] Error al iniciar:', error);
    process.exit(1);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error);
    process.exit(1);
});
