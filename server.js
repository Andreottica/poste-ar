const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 5000;

// ====================================================================
// MIDDLEWARE
// ====================================================================
app.use(express.json());

// CORS para permitir conexiones desde cualquier origen
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Servir archivos estáticos si existen (opcional)
app.use(express.static('public'));

// ====================================================================
// ALMACÉN DE DATOS
// ====================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Peers activos: peerId -> { ws, ip, lastSeen, p2pPort, alias }
const peers = new Map();

// Alias registrados (solo para validación, no persiste)
const registeredAliases = new Set();

// ====================================================================
// FUNCIONES AUXILIARES
// ====================================================================
const generateSimpleId = () => 
    Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

// ====================================================================
// ENDPOINTS HTTP
// ====================================================================

// Health check
app.get('/', (req, res) => {
    res.json({ 
        service: 'Pulso P2P Server',
        status: 'running',
        peers: peers.size,
        registeredAliases: registeredAliases.size
    });
});

// Listar peers activos (Discovery)
app.get('/peers', (req, res) => {
    const activePeers = [];
    const timeoutThreshold = 120000; // 2 minutos

    peers.forEach((peer, id) => {
        // Solo peers identificados, con puerto P2P y activos
        if (peer.p2pPort && peer.alias && (Date.now() - peer.lastSeen < timeoutThreshold)) {
            activePeers.push({
                id: id,
                alias: peer.alias,
                host: peer.ip,
                port: peer.p2pPort
            });
        }
    });

    res.json({ peers: activePeers });
});

// Registrar alias criptográfico
app.post('/register', (req, res) => {
    const { username, publicKey } = req.body;

    // Validación básica
    if (!username || !publicKey) {
        return res.status(400).json({ 
            error: 'Faltan campos requeridos (username, publicKey)' 
        });
    }

    // Verificar formato de alias (debe ser formato: palabra.palabra.palabra.00.palabra)
    const aliasPattern = /^[a-z]+\.[a-z]+\.[a-z]+\.\d{2}\.[a-z]+$/;
    if (!aliasPattern.test(username)) {
        return res.status(400).json({ 
            error: 'Formato de alias inválido' 
        });
    }

    // Verificar si ya existe
    if (registeredAliases.has(username)) {
        return res.status(409).json({ 
            error: 'Alias ya reservado',
            alias: username 
        });
    }

    // Registrar alias
    registeredAliases.add(username);
    console.log(`[REGISTER] Alias registrado: @${username}`);

    res.json({ 
        success: true,
        alias: username,
        message: 'Alias registrado exitosamente'
    });
});

// ====================================================================
// WEBSOCKET (Signaling Server)
// ====================================================================
wss.on('connection', (ws, req) => {
    const peerId = generateSimpleId();
    const clientIp = req.headers['x-forwarded-for'] 
        ? req.headers['x-forwarded-for'].split(',')[0].trim() 
        : req.socket.remoteAddress;

    // Inicializar peer
    peers.set(peerId, {
        ws,
        ip: clientIp,
        lastSeen: Date.now(),
        p2pPort: null,
        alias: null
    });

    console.log(`[+] Peer conectado: ${peerId} - IP: ${clientIp} - Total: ${peers.size}`);

    // Notificar al peer su ID temporal
    ws.send(JSON.stringify({
        type: 'YOUR_ID',
        peerId: peerId
    }));

    // ================================================================
    // MANEJO DE MENSAJES
    // ================================================================
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const peer = peers.get(peerId);

            if (!peer) return;
            
            // Actualizar timestamp
            peer.lastSeen = Date.now();

            // HEARTBEAT
            if (data.type === 'HEARTBEAT') {
                return;
            }

            // IDENTIFICACIÓN (cliente envía su alias y puerto P2P)
            if (data.type === 'IDENTIFY' && data.alias && data.p2pPort) {
                peer.alias = data.alias;
                const port = parseInt(data.p2pPort);
                if (!isNaN(port) && port > 0 && port < 65536) {
                    peer.p2pPort = port;
                }
                console.log(`[IDENTIFY] ${peerId} → @${peer.alias} | Port: ${peer.p2pPort}`);
                return;
            }

            // SEÑALES WEBRTC (Signaling)
            if (data.type === 'WEBRTC_OFFER' || 
                data.type === 'WEBRTC_ANSWER' || 
                data.type === 'ICE_CANDIDATE') {
                
                const targetPeer = peers.get(data.to);
                if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
                    data.from = peerId;
                    targetPeer.ws.send(JSON.stringify(data));
                }
                return;
            }

        } catch (err) {
            console.error(`[ERROR] Peer ${peerId}:`, err.message);
        }
    });

    // ================================================================
    // DESCONEXIÓN
    // ================================================================
    ws.on('close', () => {
        const alias = peers.get(peerId)?.alias || 'Unknown';
        peers.delete(peerId);
        console.log(`[-] Peer desconectado: ${peerId} (@${alias}) - Total: ${peers.size}`);
    });

    ws.on('error', (error) => {
        console.error(`[WS ERROR] ${peerId}:`, error.message);
    });
});

// ====================================================================
// LIMPIEZA DE PEERS INACTIVOS
// ====================================================================
setInterval(() => {
    const now = Date.now();
    const timeout = 120000; // 2 minutos

    peers.forEach((peer, id) => {
        if (now - peer.lastSeen > timeout) {
            const alias = peer.alias || 'Unknown';
            console.log(`[TIMEOUT] Peer eliminado: ${id} (@${alias})`);
            
            if (peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.close();
            }
            peers.delete(id);
        }
    });
}, 30000); // Revisar cada 30 segundos

// ====================================================================
// INICIAR SERVIDOR
// ====================================================================
server.listen(PORT, () => {
    console.log('═'.repeat(60));
    console.log('  PULSO P2P SERVER');
    console.log('═'.repeat(60));
    console.log(`  Puerto: ${PORT}`);
    console.log(`  HTTP:   http://localhost:${PORT}`);
    console.log(`  WS:     ws://localhost:${PORT}`);
    console.log('═'.repeat(60));
});
