const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 5000;

// ====================================================================
// FUNCIÓN: Generar ID de Peer
// ====================================================================
const generateSimpleId = () => {
    // Genera un ID corto y temporal para el servidor
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
};

// ====================================================================
// MIDDLEWARE BÁSICO
// ====================================================================
app.use(express.json());

// CORS básico para permitir conexiones desde cualquier origen
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Servir archivos estáticos (opcional, si hay una landing page)
app.use(express.static('public'));

// Crear servidor HTTP
const server = http.createServer(app);

// WebSocket para peers P2P (Signaling)
const wss = new WebSocket.Server({ server });

// Almacén de peers activos
// peerId -> { ws, ip, lastSeen, p2pPort, alias }
const peers = new Map();

// ====================================================================
// RUTA PARA OBTENER PEERS ACTIVOS (Discovery)
// ====================================================================
app.get('/peers', (req, res) => {
    const activePeers = [];
    const timeoutThreshold = 120000; // 2 minutos

    peers.forEach((peer, id) => {
        // Solo peers con puerto P2P definido, alias identificado y activos
        if (peer.p2pPort && peer.alias && (Date.now() - peer.lastSeen < timeoutThreshold)) {
            activePeers.push({
                alias: peer.alias,
                host: peer.ip,
                port: peer.p2pPort
            });
        }
    });

    res.json({ peers: activePeers });
});

// ====================================================================
// MANEJO DE CONEXIONES WEBSOCKET
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
        alias: null // Usaremos 'alias' para el nombre de 5 palabras
    });

    console.log(`[+] Nuevo Peer conectado: ${peerId} - IP: ${clientIp} - Total: ${peers.size}`);

    // Notificar al nuevo peer su ID temporal
    ws.send(JSON.stringify({
        type: 'YOUR_ID',
        peerId: peerId
    }));

    // El servidor ya no notifica a los demás sobre NEW_PEER,
    // ya que el cliente debe obtener esa lista mediante /peers

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
                return;
            }

            // IDENTIFICACIÓN DE USUARIO Y PUERTO (El cliente envía su alias y su puerto P2P)
            if (data.type === 'IDENTIFY' && data.alias && data.p2pPort) {
                peer.alias = data.alias;
                const port = parseInt(data.p2pPort);
                if (!isNaN(port) && port > 0 && port < 65536) {
                    peer.p2pPort = port;
                }
                console.log(`[IDENTIFY] Peer ${peerId} identificado como: @${peer.alias} | Port: ${peer.p2pPort}`);
                return;
            }

            // SEÑALES WEBRTC (Signaling)
            if (data.type === 'WEBRTC_OFFER' || data.type === 'WEBRTC_ANSWER' || data.type === 'ICE_CANDIDATE') {
                const targetPeer = peers.get(data.to);
                if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
                    data.from = peerId;
                    // Enviar la señal al peer destino
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
        peers.delete(peerId);
        const alias = peers.get(peerId) ? peers.get(peerId).alias || 'Unknown' : 'Unknown';
        console.log(`[-] Peer desconectado: ${peerId} (@${alias}) - Total: ${peers.size}`);
        // No es necesario notificar a otros peers que alguien se fue,
        // ya que el cliente actualizará la lista mediante la ruta /peers.
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
    const timeout = 120000; // 2 minutos

    peers.forEach((peer, id) => {
        if (now - peer.lastSeen > timeout) {
            const alias = peer.alias || 'Unknown';
            console.log(`[TIMEOUT] Peer inactivo eliminado: ${id} (@${alias})`);
            
            // Cerrar conexión y eliminar
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
    console.log(`[SERVER] Servidor de Discovery y Signaling corriendo en el puerto ${PORT}`);
});
