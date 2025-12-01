const express = require('express');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');

// ====================================================================
// FUNCIÓN AÑADIDA: Reemplazo minimalista para uuidv4()
// Esto garantiza que no tienes que instalar la librería 'uuid'.
// ====================================================================
const generateSimpleId = () => {
    // Genera un ID basado en el tiempo y un poco de aleatoriedad
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
};


const app = express();
const PORT = process.env.PORT || 5000;

// Middleware para parsear JSON
app.use(express.json());

// ====================================================================
// MODIFICACIÓN 1: NUEVA RUTA PARA EL CLIENTE CLI (GOSSIP)
// ====================================================================

app.get('/peers', (req, res) => {
    const activePeers = [];
    const timeoutThreshold = 120000; // 2 minutos (para considerar a un peer activo)

    peers.forEach((peer, id) => {
        // Solo devolvemos pares que tienen un puerto P2P definido y están activos
        if (peer.p2pPort && (Date.now() - peer.lastSeen < timeoutThreshold)) {
            activePeers.push({
                username: peer.username || id, 
                host: peer.ip,      
                port: peer.p2pPort  
            });
        }
    });

    res.json({ peers: activePeers });
});


// Servir archivos estáticos (landing page + descargas)
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

// Cargar usuarios desde archivo
let registeredUsers = new Map();

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

// --- Rutas API REST para el Registro ---

app.post('/register', async (req, res) => {
    const { username, password, publicKey } = req.body; 

    if (!username || !password || !publicKey) {
        return res.status(400).json({ error: 'Faltan campos.' });
    }

    if (registeredUsers.has(username)) {
        return res.status(409).json({ error: 'El nombre de usuario ya está registrado.' });
    }
    
    registeredUsers.set(username, { 
        password: password, 
        publicKey: publicKey 
    });
    await saveUsers();

    res.status(200).json({ message: 'Usuario registrado exitosamente.', username });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = registeredUsers.get(username);

    if (user && user.password === password) {
        return res.status(200).json({ message: 'Login exitoso.', username, publicKey: user.publicKey });
    } else {
        return res.status(401).json({ error: 'Credenciales inválidas.' });
    }
});


// -------------------------------------------------------------------
// Manejo de Conexiones WebSocket
// -------------------------------------------------------------------

wss.on('connection', (ws, req) => {
    // CAMBIO: Usamos nuestra función simple para generar el ID
    const peerId = generateSimpleId(); 

    const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
    
    const P2P_PORT_DEFAULT = 1987; 
    
    // ====================================================================
    // MODIFICACIÓN 2: ALMACENAR IP Y PUERTO P2P EN EL MAPA DE PEERS
    // ====================================================================
    peers.set(peerId, { 
        ws, 
        ip: clientIp, 
        lastSeen: Date.now(), 
        p2pPort: P2P_PORT_DEFAULT // <-- CAMBIO AÑADIDO
    }); 
    
    console.log(`[+] Nuevo Peer conectado: ${peerId} - IP: ${clientIp} - Total: ${peers.size}`);
    
    // Notificar al nuevo peer su ID y a todos los demás de la llegada
    ws.send(JSON.stringify({
        type: 'YOUR_ID',
        peerId: peerId
    }));
    
    peers.forEach((peer, id) => {
        if (id !== peerId && peer.ws.readyState === 1) {
            peer.ws.send(JSON.stringify({
                type: 'NEW_PEER',
                peerId: peerId
            }));
        }
    });
  
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'HEARTBEAT') {
                const peer = peers.get(peerId);
                if(peer) peer.lastSeen = Date.now();
            }

            if (data.type === 'IDENTIFY' && data.username) {
                const peer = peers.get(peerId);
                if (peer) peer.username = data.username;
            }
            
            // Reenvío de señales WebRTC (Para el cliente web original)
            if (data.type === 'WEBRTC_OFFER' || data.type === 'WEBRTC_ANSWER' || data.type === 'ICE_CANDIDATE') {
                const targetPeer = peers.get(data.to);
                if (targetPeer && targetPeer.ws.readyState === 1) {
                    data.from = peerId;
                    targetPeer.ws.send(JSON.stringify(data));
                }
            }
        } catch (err) {
            console.error('Error procesando mensaje:', err);
        }
    });
  
    ws.on('close', () => {
        const username = peers.get(peerId) ? peers.get(peerId).username : 'Desconocido';
        peers.delete(peerId);
        console.log(`[-] Peer desconectado: ${peerId} (@${username}) - Total: ${peers.size}`);
        
        peers.forEach((peer, id) => {
            if (peer.ws.readyState === 1) {
                peer.ws.send(JSON.stringify({
                    type: 'PEER_LEFT',
                    peerId: peerId
                }));
            }
        });
    });
});

// Heartbeat Timeout Checker (Mantiene activo el servidor en Render)
setInterval(() => {
    const now = Date.now();
    const timeout = 90000; // 90 segundos sin heartbeat = desconectado
  
    peers.forEach((peer, id) => {
        if (now - peer.lastSeen > timeout) {
            const username = peer.username || 'Desconocido';
            console.log(`[TIMEOUT] Peer inactivo eliminado: ${id} (@${username})`);
            
            peers.forEach((p, pid) => {
                if (pid !== id && p.ws.readyState === 1) {
                    p.ws.send(JSON.stringify({
                        type: 'PEER_LEFT',
                        peerId: id
                    }));
                }
            });
            
            if (peer.ws.readyState === 1) peer.ws.close();
            peers.delete(id);
        }
    });
}, 30000); 

// Iniciar servidor
loadUsers().then(() => {
    server.listen(PORT, () => {
        console.log(`[SERVER] Servidor corriendo en el puerto ${PORT}`);
    });
});});
