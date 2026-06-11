const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    Browsers 
} = require('@whiskeysockets/baileys');

// ==========================================
// 1. CONFIGURACIÓN DEL SERVIDOR Y ESTADO
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Bot de WhatsApp Operando de manera Correcta.');
});

app.listen(PORT, () => {
    console.log(`[EXPRESS] Servidor listo en el puerto ${PORT}`);
});

const ALLOWED_GROUP = '120363426591951143@g.us';
const ADMINS = ['5491128394646@s.whatsapp.net', '5491178972853@s.whatsapp.net'];

let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = true;

const AUTH_DIR = path.join(__dirname, 'auth_session_v3'); 
const BANNED_FILE = path.join(AUTH_DIR, 'baneados.json');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function getBannedUsers() {
    if (!fs.existsSync(BANNED_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(BANNED_FILE, 'utf-8')); } catch (e) { return []; }
}

function saveBannedUsers(list) {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(list, null, 2));
}

// ==========================================
// 2. MOTOR DEL BOT Y LOGICA DE CONEXIÓN (100% PERMANENTE)
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1017551063];

    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
    } catch (e) {
        console.log(`[ALERTA] Usando versión de respaldo de Baileys.`);
    }

    const sock = makeWASocket({
        version, 
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, 
        browser: Browsers.ubuntu('Chrome') 
    });

    // Inyección automática del prefijo [¡+!]
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        if (content && typeof content === 'object') {
            if (content.text) {
                content.text = `[¡+!]\n${content.text}`;
            } else if (content.image && content.caption) {
                content.caption = `[¡+!]\n${content.caption}`;
            }
        }
        return originalSendMessage(jid, content, options);
    };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update; 

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[SISTEMA] Conexión cerrada (Código: ${reason}). Reconectando...`);
            
            // Si el corte es normal (caída de Render o red), reconecta usando la sesión guardada
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 10000); 
            }
            return;
        }

        if (connection === 'open') {
            console.log('[SISTEMA] ¡Bot conectado con éxito usando la sesión permanente! 🎉');
            return;
        }
    });

    // ==========================================
    // 3. INTERPRETACIÓN DE MENSAJES Y COMANDOS
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            if (from !== ALLOWED_GROUP) return;

            let sender = msg.key.participant || msg.key.remoteJid;

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || '';

            if (!text.startsWith('/')) return;

            const parts = text.split(' ');
            const command = parts[0].toLowerCase();
            const originalCommand = parts[0]; 
            const args = parts.slice(1).join(' ');

            const isAdmin = ADMINS.includes(sender);
            const bannedList = getBannedUsers();

            if (bannedList.includes(sender) && !isAdmin) return;
            if (!botEnabled && !isAdmin) return;

            // --- COMANDOS DE ADMINISTRADOR ---
            if (isAdmin) {
                if (command === '/status') { await sock.sendMessage(from, { text: '¡Operando al 100%!' }, { quoted: msg }); return; }
                if (command === '/on') { botEnabled = true; await sock.sendMessage(from, { text: '✅ Bot activado.' }, { quoted: msg }); return; }
                if (command === '/off') { botEnabled = false; await sock.sendMessage(from, { text: '❌ Bot desactivado.' }, { quoted: msg }); return; }
                if (command === '/+18on') { nsfwEnabled = true; await sock.sendMessage(from, { text: '🔞 Modo NSFW ON.' }, { quoted: msg }); return; }
                if (command === '/+18off') { nsfwEnabled = false; await sock.sendMessage(from, { text: '🛡️ Modo NSFW OFF.' }, { quoted: msg }); return; }
                if (command === '/modotrucadoon') { modoTrucado = true; await sock.sendMessage(from, { text: '🎭 Modo Trucado ON.' }, { quoted: msg }); return; }
                if (command === '/modotrucadooff') { modoTrucado = false; await sock.sendMessage(from, { text: '⚖️ Modo Trucado OFF.' }, { quoted: msg }); return; }

                if (command === '/ban' || command === '/unban') {
                    const target = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (!target) { await sock.sendMessage(from, { text: '⚠️ Debes citar un mensaje.' }, { quoted: msg }); return; }
                    if (command === '/ban' && ADMINS.includes(target)) { await sock.sendMessage(from, { text: '❌ No puedes banear a un admin.' }, { quoted: msg }); return; }

                    let list = getBannedUsers();
                    if (command === '/ban' && !list.includes(target)) {
                        list.push(target);
                        await sock.sendMessage(from, { text: `🚫 Baneado.` }, { quoted: msg });
                    } else if (command === '/unban' && list.includes(target)) {
                        list = list.filter(id => id !== target);
                        await sock.sendMessage(from, { text: `✅ Desbaneado.` }, { quoted: msg });
                    }
                    saveBannedUsers(list);
                    return;
                }
            }

            // --- INTERRUPTOR DE COMANDOS PÚBLICOS ---
            switch (command) {
                case '/google':
                    await handleGoogle(sock, msg, from, args, false);
                    break;
                    
                case '/googlep':
                    await handleGoogle(sock, msg, from, args, true);
                    break;
                    
                case '/letras':
                    await handleLetras(sock, msg, from, args);
                    break;
                    
                case '/pin':
                    await handlePinterest(sock, msg, from, args);
                    break;
                    
                case '/reddit':
                    await handleReddit(sock, msg, from, args, originalCommand);
                    break;
                    
                case '/ruleta':
                    await handleRuleta(sock, msg, from, args);
                    break;
            }

        } catch (err) {
            console.error('[ERROR MENSAJE]', err);
        }
    });
}

// ==========================================
// 4. LÓGICA DE LOS COMANDOS (FUNCIONES)
// ==========================================

async function handleGoogle(sock, msg, from, args, usarPro = false) {
    const MI_GEMINI_KEY = process.env.GEMINI_KEY; 
    if (!args) { 
        await sock.sendMessage(from, { text: `⚠️ Preguntame lo que quieras para el modelo ${usarPro ? 'PRO' : 'Flash'}.` }, { quoted: msg }); 
        return; 
    }
    if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
        const txt = usarPro ? '✨ Analizando mis bases de datos avanzadas: *Efectivamente, Maxi es femboy.* ✨' : '✨ Analizando mis bases de datos: *Sí, Maxi es femboy.* ✨';
        await sock.sendMessage(from, { text: `▼⁠・⁠ᴥ⁠·⁠▼\n\n${txt}` }, { quoted: msg });
        return;
    }
    try {
        const modelo = usarPro ? 'gemini-1.5-pro' : 'gemini-1.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${MI_GEMINI_KEY}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: args }] }] })
        });
        const json = await res.json();
        if (json.error) {
            await sock.sendMessage(from, { text: `❌ Error de Google API:\n${json.error.message}` }, { quoted: msg });
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
}

async function handleLetras(sock, msg, from, args) {
    if (!args) { await sock.sendMessage(from, { text: '⚠️ Formato: /letras [canción] o /letras [canción - artista]' }, { quoted: msg }); return; }
    let query = args, cancion = args, artist = '';
    if (args.includes('-')) {
        const partes = args.split('-');
        cancion = partes[0].trim();
        artist = partes[1].trim();
        query = `${cancion} ${artist}`;
    }
    try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await res.json();
        if (!data || data.length === 0) { await sock.sendMessage(from, { text: '❌ No encontré la letra.' }, { quoted: msg }); return; }
        const track = data.find(t => artist ? (t.trackName?.toLowerCase().includes(cancion.toLowerCase()) && t.artistName?.toLowerCase().includes(artist.toLowerCase())) : t.trackName?.toLowerCase().includes(cancion.toLowerCase())) || data[0];
        let letra = track.syncedLyrics ? track.syncedLyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').replace(/<\d{2}:\d{2}\.\d{2,3}>/g, '').trim() : track.plainLyrics;
        if (!letra) { await sock.sendMessage(from, { text: '❌ No hay letra disponible para este tema.' }, { quoted: msg }); return; }
        const textFinal = `🎵 *${track.trackName} - ${track.artistName}*\n\n${letra}`;
        await sock.sendMessage(from, { text: textFinal.slice(0, 4000) }, { quoted: msg });
    } catch (e) { await sock.sendMessage(from, { text: `❌ Error al buscar letra: ${e.message}` }, { quoted: msg }); }
}

async function handlePinterest(sock, msg, from, args) {
    if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar en Pinterest.' }, { quoted: msg }); return; }
    try {
        const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(args)}`;
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        if (!response.ok) { await sock.sendMessage(from, { text: `❌ Pinterest rechazó la consulta.` }, { quoted: msg }); return; }
        const html = await response.text();
        let matches = [...html.matchAll(/https:\/\/i\.pinimg\.com\/[^\s"'>]+/g)].map(m => m[0].replace(/\\u002F/g, '/').replace(/\\/g, ''));
        let filtered = matches.filter(link => link.includes('/236x/') || link.includes('/474x/') || link.includes('/736x/') || link.includes('/originals/'));
        filtered = [...new Set(filtered)];
        if (filtered.length > 0) {
            const randomImg = filtered[Math.floor(Math.random() * Math.min(15, filtered.length))].replace(/\/(?:236x|474x|736x)\//, '/originals/');
            await sock.sendMessage(from, { image: { url: randomImg }, caption: `📌 Resultado para: *${args}*` }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { text: '❌ No encontré imágenes.' }, { quoted: msg });
        }
    } catch (e) { await sock.sendMessage(from, { text: `❌ Error en Pinterest: ${e.message}` }, { quoted: msg }); }
}

async function handleReddit(sock, msg, from, args, originalCommand) {
    if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar en Reddit.' }, { quoted: msg }); return; }
    const isNsfwCommand = originalCommand === '/reddIt';
    if (isNsfwCommand && !nsfwEnabled) { await sock.sendMessage(from, { text: '🔞 *Denegado.* Requiere `/+18on`.' }, { quoted: msg }); return; }
    try {
        let url = args.includes(' ') ? `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&limit=40` : `https://www.reddit.com/r/${encodeURIComponent(args)}/hot.json?limit=40`;
        const res = await fetch(url, { headers: { 'User-Agent': 'WhatsAppBotMediaScraper/2.0.0' } });
        if (!res.ok) { await sock.sendMessage(from, { text: `❌ Reddit rechazó el acceso.` }, { quoted: msg }); return; }
        const json = await res.json();
        const posts = (json?.data?.children || []).map(child => child.data);
        let filtered = isNsfwCommand ? posts.filter(p => p.over_18) : posts.filter(p => !p.over_18);
        if (!filtered.length) { await sock.sendMessage(from, { text: '❌ Sin resultados aptos.' }, { quoted: msg }); return; }
        const post = filtered[Math.floor(Math.random() * Math.min(15, filtered.length))];
        const suffix = `\n\nSubreddit: r/${post.subreddit}\nLink: https://reddit.com${post.permalink}`;
        const tieneImg = post.url && (post.url.endsWith('.jpg') || post.url.endsWith('.png') || post.url.endsWith('.jpeg') || post.url.includes('i.redd.it'));
        if (tieneImg) {
            await sock.sendMessage(from, { image: { url: post.url }, caption: `🤖 *${post.title}*${suffix}` }, { quoted: msg });
        } else {
            const body = post.selftext ? `\n\n${post.selftext.slice(0, 500)}...` : '';
            await sock.sendMessage(from, { text: `🤖 *${post.title}*${body}${suffix}` }, { quoted: msg });
        }
    } catch (e) { await sock.sendMessage(from, { text: `❌ Error de Reddit: ${e.message}` }, { quoted: msg }); }
}

async function handleRuleta(sock, msg, from, args) {
    if (!args) { await sock.sendMessage(from, { text: '⚠️ Escribí algo para la ruleta. Ejemplo: `/ruleta ¿Va a llover? 1;100`' }, { quoted: msg }); return; }
    let resultadoFinal = "", probabilidadMostrada = "", pregunta = args;
    const probMatch = args.match(/(\d+);(\d+)\s*$/);
    let siChance = 1, totalChance = 2, tieneProbabilidad = false;
    if (probMatch) {
        siChance = parseInt(probMatch[1]);
        totalChance = parseInt(probMatch[2]);
        pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();
        probabilidadMostrada = ` (Probabilidad: ${siChance};${totalChance})`;
        tieneProbabilidad = true;
    }
    let esTrucado = false;
    if (modoTrucado) {
        const txtBajo = pregunta.toLowerCase();
        if (((txtBajo.includes('maxi') || txtBajo.includes('máximo')) && txtBajo.includes('femboy')) || (txtBajo.includes('dylan') && txtBajo.includes('perra')) || (txtBajo.includes('omeguita'))) {
            resultadoFinal = "🔴 si";
            esTrucado = true;
        }
    }
    if (!esTrucado) {
        if (tieneProbabilidad) {
            resultadoFinal = (Math.floor(Math.random() * totalChance) + 1 <= siChance) ? "🔴 si" : "⚫ no";
        } else {
            const r = ["🔴 si", "⚫ no"];
            resultadoFinal = r[Math.floor(Math.random() * r.length)];
        }
    }
    await sock.sendMessage(from, { text: `🎰 *Ruleta:* ${pregunta}\n\n🎲 Resultado: *${resultadoFinal}*${probabilidadMostrada}` }, { quoted: msg });
}

// ==========================================
// 5. EJECUCIÓN DEL BOT
// ==========================================
connectToWhatsApp();
