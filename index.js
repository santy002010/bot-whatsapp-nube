const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// --- 1. CONFIGURACIÓN DEL SERVIDOR WEB ---
const app = express();
const PORT = process.env.PORT || 10000;
const START_TIME = Date.now();

app.get('/', (req, res) => {
    const uptimeMinutes = ((Date.now() - START_TIME) / 1000 / 60).toFixed(2);
    res.json({ status: "online", project: "WhatsApp Bot Pro", uptime_minutes: parseFloat(uptimeMinutes) });
});

app.listen(PORT, () => {
    console.log(`[SERVER] 🌐 Monitor Express activo en el puerto ${PORT}`);
});

// --- 2. CONFIGURACIÓN DE BAILEYS ---
console.log('[BOT] Inicializando motor de WhatsApp con Baileys...');

const logger = pino({ level: 'error' });
let sock;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        
        sock = makeWASocket({
            auth: state,
            logger: logger,
            printQRInTerminal: true,
            browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            defaultQueryTimeoutMs: 60000,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if(qr) {
                console.log('\n📱 ESCANEA ESTE CÓDIGO QR CON TU TELÉFONO PARA CONECTAR:\n');
            }
            
            if(connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
                
                if(shouldReconnect && connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
                    connectionAttempts++;
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else if(connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.error('[CRÍTICO] Máximo número de intentos de reconexión alcanzado');
                    process.exit(1);
                }
            } 
            else if(connection === 'open') {
                connectionAttempts = 0;
                console.log('\n==================================================');
                console.log('🎉 ¡SISTEMA PRO ACTIVADO! El bot está en la nube y conectado. 🎉');
                console.log('==================================================\n');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // --- 4. COMANDOS ---
        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            
            if (!msg.message || msg.key.fromMe) return;
            
            const messageBody = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
            if (!messageBody.startsWith('!')) return;

            const args = messageBody.slice(1).split(/ +/);
            const command = args.shift().toLowerCase();
            const jid = msg.key.remoteJid;

            try {
                switch (command) {
                    case 'hola':
                        await sock.sendMessage(jid, { text: '🤖 *¡Modo Pro Activo!* Hola, estoy corriendo estable 24/7.' });
                        break;
                    case 'status':
                    case 'ping':
                        const uptime = ((Date.now() - START_TIME) / 1000 / 60).toFixed(1);
                        const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
                        await sock.sendMessage(jid, { text: `📊 *ESTADO*\n🟢 Operativo\n⏱️ ${uptime} min\n💾 RAM: ${memory} MB` });
                        break;
                    case 'reiniciar':
                        await sock.sendMessage(jid, { text: '🔄 Reiniciando bot en la nube...' });
                        setTimeout(() => { process.exit(0); }, 1500);
                        break;
                    default:
                        await sock.sendMessage(jid, { text: '❓ Comando no reconocido. Usa: !hola, !status, !reiniciar' });
                }
            } catch (err) {
                console.error('Error procesando mensaje:', err);
            }
        });

    } catch (err) {
        console.error('[ERROR] No se pudo conectar:', err);
        connectionAttempts++;
        if(connectionAttempts < MAX_RECONNECT_ATTEMPTS) {
            setTimeout(() => connectToWhatsApp(), 5000);
        }
    }
}

// --- 5. SALVAVIDAS ---
process.on('unhandledRejection', (reason, p) => {
    console.error('[ERROR] Promesa rechazada:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[CRÍTICO] Excepción:', err);
    process.exit(1);
});

connectToWhatsApp();
