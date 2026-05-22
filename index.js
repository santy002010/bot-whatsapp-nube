const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');

// --- 1. SERVIDOR EXPRESS ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot Privado Pro Activo 🚀'));
app.listen(PORT, () => console.log(`[SERVER] Monitor activo en puerto ${PORT}`));

// --- 2. CONFIGURACIÓN DE SEGURIDAD Y GRUPO ---
const GRUPO_PERMITIDO = '120363426591951143@g.us'; // Tu grupo

let botActivo = true;       
let nsfwPermitido = false;  

// --- 3. SISTEMA DE BANEOS INTERNOS ---
// Guarda la lista negra en la carpeta protegida de Render para que nunca se borre
const banFile = './auth_session/baneados.json';
let baneados = [];
try { 
    if (fs.existsSync(banFile)) baneados = JSON.parse(fs.readFileSync(banFile)); 
} catch(e) {}

function guardarBaneos() {
    try { 
        if (!fs.existsSync('./auth_session')) fs.mkdirSync('./auth_session');
        fs.writeFileSync(banFile, JSON.stringify(baneados)); 
    } catch(e) {}
}

// --- 4. MOTORES DE BÚSQUEDA ---

// Reddit (Imágenes)
async function searchReddit(query, allowNsfw) {
    try {
        const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance`);
        const json = await res.json();
        const posts = json.data?.children || [];
        for (const post of posts) {
            const data = post.data;
            if (data.over_18 && !allowNsfw) continue; 
            if (data.url && data.url.match(/\.(jpeg|jpg|gif|png)$/i)) return { url: data.url, title: data.title };
        }
        return null;
    } catch (e) { return null; }
}

// Pinterest (Imágenes)
async function searchPinterest(query) {
    try {
        const res = await fetch(`https://ar.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`);
        const html = await res.text();
        const regex = /https:\/\/i\.pinimg\.com\/[^\s"'>]+\.(jpg|jpeg|png)/gi;
        const matches = html.match(regex);
        if (matches && matches.length > 0) {
            const highRes = matches.filter(url => url.includes('originals') || url.includes('736x'));
            return highRes.length > 0 ? highRes[0] : matches[0];
        }
        return null;
    } catch (e) { return null; }
}

// Google (Motor cambiado a la API de Wikipedia para evitar bloqueos del servidor)
async function searchGoogle(query) {
    try {
        const searchRes = await fetch(`https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`);
        const searchJson = await searchRes.json();
        
        if (!searchJson.query || searchJson.query.search.length === 0) {
            return "❌ No encontré información detallada sobre eso. Intenta buscarlo con otras palabras.";
        }
        
        // Obtiene el artículo más relevante
        const title = searchJson.query.search[0].title;
        const exactRes = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
        const exactJson = await exactRes.json();
        
        if (exactJson.extract) {
            return `🔍 *Información: ${title}*\n\n📝 ${exactJson.extract}`;
        } else {
            const snippet = searchJson.query.search[0].snippet.replace(/<[^>]*>/g, '');
            return `🔍 *Información: ${title}*\n\n📝 ${snippet}...`;
        }
    } catch (e) { 
        return "❌ Ocurrió un error al buscar la información."; 
    }
}

// --- 5. SISTEMA CENTRAL DEL BOT ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                // Aquí pide código en caso de desvincularse
                const code = await sock.requestPairingCode('5491128394646');
                console.log('\n==================================================');
                console.log(`🔑 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log('==================================================\n');
            } catch (error) { console.error('[ERROR]', error.message); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            if (statusCode === 405) process.exit(1);
            startBot();
        } else if (connection === 'open') {
            console.log('\n🚀 ¡BOT ONLINE Y LISTO EN TU GRUPO! 🚀\n');
        }
    });

    // --- 6. COMANDOS ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        if (chatId !== GRUPO_PERMITIDO) return; // Solo responde en tu grupo

        const sender = msg.key.participant || msg.key.remoteJid; 
        const esAdmin = sender.includes('1128394646'); 

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption;
        if (!text || !text.startsWith('/')) return;

        const args = text.slice(1).split(/ +/);
        const command = args.shift().toLowerCase();
        const query = args.join(' ');

        const citado = msg.message.extendedTextMessage?.contextInfo;
        const usuarioCitado = citado?.participant;

        // 🔒 COMANDOS DE ADMIN
        if (['on', 'off', 'restart', 'restard', '+18on', '+18off', 'ban', 'unban'].includes(command)) {
            if (!esAdmin) return await sock.sendMessage(chatId, { text: '❌ No tienes autorización. Solo mi creador manda.' });

            switch(command) {
                case 'on':
                    botActivo = true;
                    return await sock.sendMessage(chatId, { text: '🟢 *Bot Encendido.*' });
                
                case 'off':
                    botActivo = false;
                    return await sock.sendMessage(chatId, { text: '🔴 *Bot Apagado.* Ignoraré todos los comandos.' });
                
                case 'restart':
                case 'restard':
                    await sock.sendMessage(chatId, { text: '🔄 *Reiniciando servidores...* Vuelvo en 30s.' });
                    setTimeout(() => process.exit(0), 1000);
                    return;
                
                case '+18on':
                    nsfwPermitido = true;
                    return await sock.sendMessage(chatId, { text: '🔞 *Modo +18 Activado.*' });
                
                case '+18off':
                    nsfwPermitido = false;
                    return await sock.sendMessage(chatId, { text: '🛡️ *Modo +18 Desactivado.*' });

                case 'ban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Responde/Cita el mensaje de la persona que quieras banear del bot.' });
                    if (usuarioCitado.includes('1128394646')) return await sock.sendMessage(chatId, { text: '❌ No podés banearte a vos mismo, jefe.' });
                    
                    if (!baneados.includes(usuarioCitado)) {
                        baneados.push(usuarioCitado);
                        guardarBaneos();
                    }
                    return await sock.sendMessage(chatId, { text: '🔨 *Usuario añadido a la Lista Negra.* Ya no leeré sus comandos.' });

                case 'unban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Responde/Cita un mensaje del usuario para perdonarlo.' });
                    baneados = baneados.filter(u => u !== usuarioCitado);
                    guardarBaneos();
                    return await sock.sendMessage(chatId, { text: '✅ *Usuario perdonado.* Puede volver a usar el bot.' });
            }
        }

        // Si el bot fue apagado con /off, frena todo.
        if (!botActivo) return;

        // 🛡️ BARRERA DE LISTA NEGRA: Si el usuario está baneado y no es el Admin, lo ignoramos en silencio.
        if (baneados.includes(sender) && !esAdmin) return;

        // 🌍 COMANDOS DE BÚSQUEDA GENERAL
        switch (command) {
            case 'google':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Escribe qué buscar. Ejemplo: `/google Maradona`' });
                const resGoogle = await searchGoogle(query);
                await sock.sendMessage(chatId, { text: resGoogle });
                break;

            case 'reddit':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/reddit gatos`' });
                const resReddit = await searchReddit(query, nsfwPermitido);
                if (resReddit) {
                    await sock.sendMessage(chatId, { image: { url: resReddit.url }, caption: `🤖 *Reddit:* ${resReddit.title}` });
                } else {
                    await sock.sendMessage(chatId, { text: nsfwPermitido ? '❌ No encontré imágenes.' : '❌ Filtro +18 activo o sin resultados.' });
                }
                break;

            case 'pin':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/pin paisaje hd`' });
                const imgPin = await searchPinterest(query);
                if (imgPin) {
                    await sock.sendMessage(chatId, { image: { url: imgPin }, caption: `📌 *Pinterest:* Resultado para "${query}"` });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ No encontré imágenes en Pinterest.' });
                }
                break;
        }
    });
}

startBot();
