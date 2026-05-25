const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');

// --- SERVIDOR WEB (Para UptimeRobot) ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.status(200).send('<h1>Bot WhatsApp Pro Online 🚀</h1>'));
app.listen(PORT, () => console.log(`[SERVER] Puerto ${PORT} activo`));

// --- CONFIGURACIÓN ---
const GRUPO_PERMITIDO = '120363426591951143@g.us';
const ADMINS = ['5491128394646', '5491178972853']; // Tu número y el de tu amigo

let botActivo = true;
let nsfwPermitido = false;

// --- SISTEMA DE BANEOS ---
const banFile = './auth_session/baneados.json';
let baneados = [];
try { 
    if (fs.existsSync(banFile)) baneados = JSON.parse(fs.readFileSync(banFile, 'utf-8')); 
} catch(e) {}

function guardarBaneos() { 
    if (!fs.existsSync('./auth_session')) fs.mkdirSync('./auth_session');
    fs.writeFileSync(banFile, JSON.stringify(baneados, null, 2)); 
}

// --- MOTORES DE BÚSQUEDA ---
async function searchReddit(query, allowNsfw) {
    try {
        const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        const posts = json.data?.children || [];
        for (const post of posts) {
            if (post.data.over_18 && !allowNsfw) continue;
            if (post.data.url?.match(/\.(jpeg|jpg|gif|png)$/i)) return { url: post.data.url, title: post.data.title };
        }
        return null;
    } catch (e) { return null; }
}

async function searchPinterest(query, allowNsfw) {
    try {
        // 🔥 MODIFICADO: adlt=off desactiva el SafeSearch de Bing si allowNsfw es true
        const filtroBing = allowNsfw ? 'adlt=off' : 'adlt=strict';
        const res = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&${filtroBing}`, { headers: { 'User-Agent': 'Mozilla/5.0' }});
        const html = await res.text();
        const matches = [...html.matchAll(/(https:\/\/[^"'\s&<>]+\.(?:jpg|jpeg|png))/gi)];
        return matches.length > 0 ? matches[0][1] : null;
    } catch (e) { return null; }
}

async function searchGoogle(query) {
    try {
        let cleanQuery = query.replace(/^(qué es|que es|quién es|quien es|qué significa|que significa)\s+(un|una|el|la|los|las)?\s*/i, '').trim();
        if (!cleanQuery) cleanQuery = query;

        const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanQuery)}`);
        const json = await res.json();
        return json.extract ? `🔍 *${json.title}*\n\n${json.extract}` : "❌ No encontré resultados exactos. Intentá usar solo palabras clave.";
    } catch(e) { return "❌ Error de conexión con la base de datos."; }
}

// --- NÚCLEO DEL BOT ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: 'silent' }), 
        browser: ["Ubuntu", "Chrome", "20.0.04"] 
    });

    // Petición del código de vinculación (Tu número)
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode('5491128394646');
                console.log('\n==================================================');
                console.log(`🔑 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log('==================================================\n');
            } catch (e) { }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    // Gestor de conexión seguro (5 minutos)
    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'close') {
            const yaVinculado = sock.authState.creds.registered;
            const tiempo = yaVinculado ? 10000 : 300000;
            console.log(`\n[ALERTA] Desconectado. Reconectando en ${tiempo/1000} segundos...\n`);
            setTimeout(startBot, tiempo);
        } else if (connection === 'open') {
            console.log('\n🚀 [SISTEMA] ¡BOT ONLINE EN EL GRUPO! 🚀\n');
        }
    });

    // Lector de mensajes
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid !== GRUPO_PERMITIDO) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const esAdmin = msg.key.fromMe || ADMINS.some(a => sender.includes(a));
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
        
        if (!text.startsWith('/')) return;

        const args = text.slice(1).split(/ +/);
        const command = args.shift().toLowerCase();
        const query = args.join(' ');

        // COMANDO STATUS
        if (command === 'status') {
            return await sock.sendMessage(msg.key.remoteJid, { text: "✅ ¡Hola! Estoy vivo y conectado a WhatsApp, funciono perfectamente." });
        }

        // COMANDOS DE ADMIN
        if (['on', 'off', 'ban', 'unban', '+18on', '+18off'].includes(command)) {
            if (!esAdmin) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ No tenés autorización.' });
            
            switch(command) {
                case 'on': botActivo = true; return await sock.sendMessage(msg.key.remoteJid, { text: '🟢 *Bot Encendido.*' });
                case 'off': botActivo = false; return await sock.sendMessage(msg.key.remoteJid, { text: '🔴 *Bot Apagado.*' });
                case '+18on': nsfwPermitido = true; return await sock.sendMessage(msg.key.remoteJid, { text: '🔞 *Modo +18 Activado (Reddit y /pin sin censura).*' });
                case '+18off': nsfwPermitido = false; return await sock.sendMessage(msg.key.remoteJid, { text: '🛡️ *Modo +18 Desactivado (Filtros activados).*' });
                case 'ban': 
                    const user = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if(!user) return await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Respondé al mensaje de quien quieras banear.' });
                    if(ADMINS.some(a => user.includes(a))) return await sock.sendMessage(msg.key.remoteJid, { text: '❌ No podés banear a un Administrador.' });
                    
                    if(!baneados.includes(user)) { baneados.push(user); guardarBaneos(); }
                    return await sock.sendMessage(msg.key.remoteJid, { text: '🔨 *Usuario añadido a la Lista Negra.*' });
                case 'unban':
                    const userU = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if(!userU) return await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Respondé a un mensaje del usuario.' });
                    
                    baneados = baneados.filter(u => u !== userU); 
                    guardarBaneos(); 
                    return await sock.sendMessage(msg.key.remoteJid, { text: '✅ *Usuario perdonado.*' });
            }
        }

        if (!botActivo) return;
        if (baneados.includes(sender)) {
            if (!esAdmin) return await sock.sendMessage(msg.key.remoteJid, { text: '🚫 *Acceso denegado:* Estás baneado del bot.' });
        }

        // COMANDOS PÚBLICOS
        if (command === 'google') {
            if (!query) return await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ ¿Qué querés buscar?' });
            const res = await searchGoogle(query);
            await sock.sendMessage(msg.key.remoteJid, { text: res });
        } else if (command === 'reddit') {
            if (!query) return await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Ejemplo: `/reddit gatos`' });
            const res = await searchReddit(query, nsfwPermitido);
            if (res) {
                await sock.sendMessage(msg.key.remoteJid, { image: { url: res.url }, caption: res.title });
            } else {
                await sock.sendMessage(msg.key.remoteJid, { text: '❌ Sin resultados o bloqueado por filtro +18.' });
            }
        } else if (command === 'pin') {
            if (!query) return await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Ejemplo: `/pin auto`' });
            // 🔥 AHORA PASA EL ESTADO DE NSFW PERMITIDO A BING
            const res = await searchPinterest(query, nsfwPermitido);
            if (res) {
                await sock.sendMessage(msg.key.remoteJid, { image: { url: res }, caption: `📌 ${query}` });
            } else {
                await sock.sendMessage(msg.key.remoteJid, { text: '❌ No encontré imágenes (o la búsqueda explícita está bloqueada).' });
            }
        }
    });
}

startBot();
