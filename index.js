const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

// ==========================================
// CONFIGURACIÓN INICIAL
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;

// Tu número de teléfono (se lee de Render o usa el tuyo por defecto)
const HOST_NUMBER = process.env.HOST_NUMBER || '5491128394646'; 
const modoTrucado = true; // Activa el huevo de pascua de Maxi

// Candado virtual para evitar que se soliciten códigos infinitos en bucle
let codigoSolicitado = false; 

// Servidor Express básico para que Render no tire error de puerto
app.get('/', (req, res) => res.send('Bot Activo 🚀'));
app.listen(PORT, () => {
    console.log(`[EXPRESS] Servidor listo en el puerto ${PORT}`);
});

// ==========================================
// FUNCIÓN PRINCIPAL DEL BOT
// ==========================================
async function connectToWhatsApp() {
    // Crea la carpeta 'session' para guardar las credenciales
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Apaga logs molestos de la librería
        printQRInTerminal: false,          // Falso porque usamos código de vinculación
        syncFullHistory: false             // Clave para que Render no explote por falta de RAM
    });

    // Guardar credenciales cada vez que se actualizan
    sock.ev.on('creds.update', saveCreds);

    // 🔄 CONTROL DE CONEXIÓN (Acá adentro vive 'connection')
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // Si la conexión se cierra, reseteamos el candado e intentamos reconectar
        if (connection === 'close') {
            codigoSolicitado = false; 
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[SISTEMA] Conexión cerrada por código: ${reason}. Reconectando...`);
            
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 5000); // Reintenta en 5 segundos
            }
            return;
        }

        // Si conecta con éxito, aseguramos el estado del candado
        if (connection === 'open') {
            console.log('[SISTEMA] ¡Bot conectado con éxito a WhatsApp! 🎉');
            codigoSolicitado = false;
            return;
        }

        // 🔑 SOLICITUD DEL CÓDIGO DE VINCULACIÓN
        if (!sock.authState.creds.registered && !codigoSolicitado) {
            codigoSolicitado = true; // Cerramos el candado inmediatamente

            setTimeout(async () => {
                try {
                    // Limpiamos el número de espacios o caracteres raros
                    const numeroLimpio = HOST_NUMBER.replace(/[^0-9]/g, '');
                    console.log(`[VINCULACIÓN] Solicitando código para el número: ${numeroLimpio}`);
                    
                    let code = await sock.requestPairingCode(numeroLimpio);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    
                    console.log(`\n====================================`);
                    console.log(`🔥 TU CÓDIGO DE VINCULACIÓN: ${code.toUpperCase()} 🔥`);
                    console.log(`====================================\n`);
                } catch (err) {
                    console.error(`❌ Error crítico al solicitar el código:`, err.message);
                    codigoSolicitado = false; // Si falla el intento, abrimos el candado para reintentar
                }
            }, 6000); // Espera estratégica de 6 segundos para estabilizar la red
        }
    });

    // 💬 CONTROL DE MENSAJES RECIBIDOS (Comandos /google y /googlep)
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const msg = chatUpdate.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJoin || msg.key.remoteJid;
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            
            if (!textMessage.startsWith('/')) return;

            const parts = textMessage.trim().split(' ');
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' ');

            const MI_GEMINI_KEY = process.env.GEMINI_KEY;

            // 🧠 COMANDO: /google (Gemini 3.5 Flash)
            if (command === '/google') {
                if (!args) { 
                    await sock.sendMessage(from, { text: '⚠️ Preguntame lo que quieras.' }, { quoted: msg }); 
                    return; 
                }

                if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
                    await sock.sendMessage(from, { text: '▼⁠・⁠ᴥ⁠·⁠▼\n\n✨ Analizando mis bases de datos: *Sí, Maxi es femboy.* ✨' }, { quoted: msg });
                    return;
                }

                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${MI_GEMINI_KEY}`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: args }] }] })
                    });
                    const json = await res.json();

                    if (json.error) {
                        await sock.sendMessage(from, { text: `❌ Error de Google API:\n${json.error.message}\n\n💡 Tip: Revisá que la clave en el Environment de Render esté bien copiada.` }, { quoted: msg });
                        return;
                    }

                    if (json.candidates && json.candidates[0]?.content?.parts?.[0]?.text) {
                        await sock.sendMessage(from, { text: `▼⁠・⁠ᴥ⁠·⁠▼\n\n${json.candidates[0].content.parts[0].text}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No pude procesar la estructura de la respuesta.' }, { quoted: msg });
                    }
                } catch (e) {
                    await sock.sendMessage(from, { text: `❌ Fallo en fetch: ${e.message}` }, { quoted: msg });
                }
                return;
            }

            // 🌟 COMANDO: /googlep (Gemini 3.1 Pro)
            if (command === '/googlep') {
                if (!args) { 
                    await sock.sendMessage(from, { text: '⚠️ Preguntame lo que quieras para el modelo PRO.' }, { quoted: msg }); 
                    return; 
                }

                if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
                    await sock.sendMessage(from, { text: '▼⁠・⁠ᴥ⁠·⁠▼\n\n✨ Analizando mis bases de datos avanzadas: *Efectivamente, Maxi es femboy.* ✨' }, { quoted: msg });
                    return;
                }

                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${MI_GEMINI_KEY}`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: args }] }] })
                    });
                    const json = await res.json();

                    if (json.error) {
                        await sock.sendMessage(from, { text: `❌ Error en Google PRO:\n${json.error.message}` }, { quoted: msg });
                        return;
                    }

                    if (json.candidates && json.candidates[0]?.content?.parts?.[0]?.text) {
                        await sock.sendMessage(from, { text: `▼⁠・⁠ᴥ⁠·⁠▼\n\n${json.candidates[0].content.parts[0].text}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No pude procesar tu pregunta en la versión PRO.' }, { quoted: msg });
                    }
                } catch (e) {
                    await sock.sendMessage(from, { text: `❌ Fallo en fetch PRO: ${e.message}` }, { quoted: msg });
                }
                return;
            }

        } catch (err) {
            console.error('[ERROR MENSAJE]', err);
        }
    });
}

// Arranca el flujo de conexión
connectToWhatsApp();
