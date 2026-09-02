const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (_req, res) => {
    res.send('Bot de WhatsApp operando correctamente.');
});
app.listen(PORT, () => {
    console.log(`[EXPRESS] Servidor listo en el puerto ${PORT}`);
});

const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://bot-whatsapp-nube.onrender.com';
setInterval(() => { fetch(SELF_URL).catch(() => {}); }, 8 * 60 * 1000);

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('[ERROR] Falta la variable MONGO_URI en Render.');
    process.exit(1);
}

const DB_NAME = 'whatsapp_bot_db';
const COLLECTION_NAME = 'auth_session';
const HOST_NUMBER = (process.env.HOST_NUMBER || '5491128394646').replace(/[^0-9]/g, '');
const EXTRA_ADMIN = (process.env.EXTRA_ADMIN || '5491178972853').replace(/[^0-9]/g, '');
const GROUP_ID = process.env.GROUP_ID || '120363426591951143@g.us';
const ALLOWED_CHATS = [GROUP_ID, `${HOST_NUMBER}@s.whatsapp.net`];
const ADMINS = [`${HOST_NUMBER}@s.whatsapp.net`, `${EXTRA_ADMIN}@s.whatsapp.net`];
const AUTH_DIR = path.join(__dirname, 'config_local');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const INSTRUCCION_GEMINI = [
    'Respondes dentro de WhatsApp.',
    'Escribe texto simple, corto y facil de leer en el celular.',
    'No uses titulos con #.',
    'No uses markdown de doble asterisco.',
    'Si hace falta negrita, usa un solo asterisco de cada lado, asi: *esto*.',
    'No armes tablas.',
    'No pongas prefijos como Gemini, Respuesta o Asistente.',
    'No empieces con hola si no te saludaron.',
    'Separa ideas con renglones vacios.',
    'Si enumeras, usa 1. 2. 3. o un punto medio, no guiones raros.',
    'Responde en el mismo idioma de la pregunta.',
    'Se claro y directo.'
].join(' ');

let botEnabled = true;
let soloAdmins = false;
let codigoSolicitado = false;
let sockActivo = null;
let banCol = null;
let bannedCache = [];
const vistos = new Set();

function normalizarNumero(valor) {
    if (!valor) return '';
    return String(valor).replace(/[^0-9]/g, '').replace(/^549/, '54');
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function esGrupoJid(jid) {
    const t = String(jid || '');
    return t.includes('@g.us') || t.includes('@broadcast');
}
function yaVisto(id) {
    if (!id) return false;
    if (vistos.has(id)) return true;
    vistos.add(id);
    if (vistos.size > 400) {
        const primero = vistos.values().next().value;
        vistos.delete(primero);
    }
    return false;
}
function esAdminNumero(num) {
    const n = normalizarNumero(num);
    return ADMINS.some((admin) => normalizarNumero(admin) === n) || n === normalizarNumero(HOST_NUMBER);
}
function estaBaneado(sender) {
    const n = normalizarNumero(sender);
    return bannedCache.some((b) => normalizarNumero(b) === n);
}
async function persistBanned() {
    if (!banCol) return;
    await banCol.deleteMany({});
    if (bannedCache.length) await banCol.insertMany(bannedCache.map((numero) => ({ numero })));
}
function numeroDeComando(args, msg) {
    const citado = msg?.message?.extendedTextMessage?.contextInfo?.participant
        || msg?.message?.extendedTextMessage?.contextInfo?.remoteJid
        || '';
    return normalizarNumero(args || citado);
}
function limpioWhatsApp(texto) {
    return String(texto || '')
        .replace(/^\s*(gemini\s*pro\s*:|gemini\s*:|respuesta\s*:)\s*/i, '')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/```[\w+-]*\n?/g, '')
        .replace(/^[ \t]*[-*]\s+/gm, '• ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const payload = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.updateOne({ _id: id }, { $set: payload }, { upsert: true });
    };
    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
        } catch (_err) { return null; }
    };
    const removeData = async (id) => { await collection.deleteOne({ _id: id }); };
    const creds = (await readData('creds')) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function askGeminiWithRetry(prompt, usarPro = false, reintentos = 2) {
    const key = process.env.GEMINI_KEY;
    if (!key || key === 'TU_API_KEY_AQUI') throw new Error('Falta GEMINI_KEY en Render');
    const genAI = new GoogleGenerativeAI(key);
    const modelos = usarPro
        ? [process.env.GEMINI_MODEL_PRO, 'gemini-3.1-pro-preview', 'gemini-3.6-flash'].filter(Boolean)
        : [process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.7-flash'].filter(Boolean);
    let ultimoError;
    for (const modelo of modelos) {
        for (let i = 0; i <= reintentos; i++) {
            try {
                const model = genAI.getGenerativeModel({
                    model: modelo,
                    systemInstruction: INSTRUCCION_GEMINI
                });
                const result = await model.generateContent(prompt);
                const text = result.response.text();
                if (text && text.trim()) return text;
            } catch (err) {
                ultimoError = err;
                await wait(700 * (i + 1));
            }
        }
    }
    throw ultimoError || new Error('Gemini no respondio');
}

async function handleAyuda(sock, from) {
    const texto = [
        '*Comandos*',
        '/ayuda - esta lista',
        '/gemini [texto] - preguntar a Gemini',
        '/geminiP [texto] - Gemini Pro',
        '/letras [cancion] - buscar letra',
        '/pin [texto] - buscar imagen',
        '/reddit [texto] - buscar en Reddit',
        '/ruleta [pregunta] - si o no, chance 1;2',
        '/ruleta [pregunta] 1;4 - chance personalizada',
        '/test - probar comandos',
        '',
        '*Solo admin*',
        '/status - estado del bot',
        '/on - prender el bot para todos',
        '/off - apagar el bot (solo admins siguen)',
        '/admins on - solo los admins pueden usar el bot',
        '/admins off - todos los chats permitidos pueden usarlo',
        '/admins - ver si el modo solo admins esta ON u OFF',
        '/ban [numero] - prohibir el bot (o responde un mensaje y /ban)',
        '/unban [numero] - quitar el ban',
        '/baneados - lista de baneados'
    ].join('\n');
    await sock.sendMessage(from, { text: texto });
}
async function handleStatus(sock, from) {
    await sock.sendMessage(from, {
        text: ['Operando al 100%.', `Bot: ${botEnabled ? 'prendido' : 'apagado para no admins'}`, `Modo solo admins: ${soloAdmins ? 'ON' : 'OFF'}`].join('\n')
    });
}
async function handleBan(sock, from, msg, args) {
    const num = numeroDeComando(args, msg);
    if (!num) return sock.sendMessage(from, { text: 'Usa /ban 549... o responde un mensaje con /ban' });
    if (esAdminNumero(num)) return sock.sendMessage(from, { text: 'No se puede banear a un admin.' });
    if (estaBaneado(num)) return sock.sendMessage(from, { text: `${num} ya estaba baneado.` });
    bannedCache.push(num);
    await persistBanned();
    await sock.sendMessage(from, { text: `Baneado: ${num}. Ya no puede usar el bot.` });
}
async function handleUnban(sock, from, msg, args) {
    const num = numeroDeComando(args, msg);
    if (!num) return sock.sendMessage(from, { text: 'Usa /unban 549...' });
    const antes = bannedCache.length;
    bannedCache = bannedCache.filter((b) => normalizarNumero(b) !== num);
    if (bannedCache.length === antes) return sock.sendMessage(from, { text: `${num} no estaba baneado.` });
    await persistBanned();
    await sock.sendMessage(from, { text: `Desbaneado: ${num}` });
}
async function handleBaneados(sock, from) {
    if (!bannedCache.length) return sock.sendMessage(from, { text: 'No hay nadie baneado.' });
    await sock.sendMessage(from, { text: 'Baneados:\n' + bannedCache.map((n) => `- ${n}`).join('\n') });
}
async function handleGemini(sock, from, args, usarPro = false) {
    if (!args) return sock.sendMessage(from, { text: usarPro ? 'Formato: /geminiP [tu consulta]' : 'Formato: /gemini [tu consulta]' });
    try {
        const text = limpioWhatsApp(await askGeminiWithRetry(args, usarPro));
        if (!text) return sock.sendMessage(from, { text: 'No pude armar una respuesta.' });
        await sock.sendMessage(from, { text });
    } catch (err) {
        await sock.sendMessage(from, { text: usarPro ? `No pude usar Pro. ${err.message}` : `Error: ${err.message}` });
    }
}
async function handleLetras(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Formato: /letras [cancion]' });
    try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(args)}`);
        const data = await res.json();
        if (!data || !data.length) return sock.sendMessage(from, { text: 'No encontre la letra.' });
        const track = data[0];
        const letra = track.syncedLyrics ? track.syncedLyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim() : track.plainLyrics;
        await sock.sendMessage(from, { text: (`*${track.trackName}* - ${track.artistName}\n\n${letra || 'Sin letra.'}`).substring(0, 4000) });
    } catch (_err) {
        await sock.sendMessage(from, { text: 'Error al buscar la letra.' });
    }
}
async function handleReddit(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Formato: /reddit [texto]' });
    try {
        let posts = [];
        const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&limit=25&raw_json=1`, { headers: { 'User-Agent': 'Mozilla/5.0 BotWhatsApp/2.1', Accept: 'application/json' } });
        if (res.ok) {
            const json = await res.json();
            posts = (json?.data?.children || []).map((item) => item.data).filter((post) => post && !post.over_18);
        }
        if (!posts.length) {
            const alt = await fetch(`https://api.pullpush.io/reddit/search/submission/?q=${encodeURIComponent(args)}&size=20`);
            if (alt.ok) {
                const json = await alt.json();
                posts = (json?.data || []).filter((post) => post && !post.over_18);
            } else if (!res.ok) throw new Error(`Reddit HTTP ${res.status}. Render suele bloquear esa web.`);
        }
        if (!posts.length) return sock.sendMessage(from, { text: 'Sin resultados aptos.' });
        const post = posts[Math.floor(Math.random() * Math.min(15, posts.length))];
        const extra = `\n\nr/${post.subreddit || '?'}\nhttps://reddit.com${post.permalink || ''}`;
        const urlImg = post.url || '';
        const esImagen = urlImg && (/\.(jpeg|jpg|gif|png)$/i.test(urlImg) || urlImg.includes('i.redd.it'));
        if (esImagen) await sock.sendMessage(from, { image: { url: urlImg }, caption: `*${post.title || args}*${extra}` });
        else await sock.sendMessage(from, { text: `*${post.title || args}*${post.selftext ? '\n\n' + String(post.selftext).slice(0, 500) : ''}${extra}` });
    } catch (err) {
        await sock.sendMessage(from, { text: `Error con Reddit: ${err.message}` });
    }
}
async function handlePinterest(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Formato: /pin [texto]' });
    const key = process.env.GOOGLE_SEARCH_KEY;
    const cx = process.env.GOOGLE_CX || process.env.PINTEREST_CX;
    if (!key || !cx) return sock.sendMessage(from, { text: 'Faltan GOOGLE_SEARCH_KEY y GOOGLE_CX en Render.' });
    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(args)}&searchType=image`;
        const res = await fetch(url);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json?.error?.message || `HTTP ${res.status}`) + '. Activa Custom Search JSON API e Image search.');
        const items = json.items || [];
        if (!items.length) return sock.sendMessage(from, { text: 'No encontre imagenes.' });
        await sock.sendMessage(from, { image: { url: items[Math.floor(Math.random() * items.length)].link }, caption: `Busqueda: *${args}*` });
    } catch (err) {
        await sock.sendMessage(from, { text: `Error en el buscador: ${err.message}` });
    }
}
async function handleRuleta(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Ejemplo:\n/ruleta Va a llover?\n/ruleta Va a llover? 1;2' });
    let pregunta = args, siChance = 1, totalChance = 2;
    const match = args.match(/(\d+);(\d+)\s*$/);
    if (match) {
        siChance = parseInt(match[1], 10);
        totalChance = parseInt(match[2], 10);
        pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();
    }
    if (!totalChance) totalChance = 2;
    const numero = Math.floor(Math.random() * totalChance) + 1;
    await sock.sendMessage(from, { text: `Ruleta: ${pregunta}\nChance: ${siChance};${totalChance}\nResultado: *${numero <= siChance ? 'si' : 'no'}*` });
}
async function handleTestCadena(sock, from) {
    await sock.sendMessage(from, { text: 'Iniciando prueba de comandos...' });
    const tests = [
        { nombre: '/status', run: () => handleStatus(sock, from) },
        { nombre: '/admins', run: () => sock.sendMessage(from, { text: `Modo solo admins ahora: ${soloAdmins ? 'ON' : 'OFF'}` }) },
        { nombre: '/ruleta', run: () => handleRuleta(sock, from, 'El bot responde?') },
        { nombre: '/letras', run: () => handleLetras(sock, from, 'Kali Uchis Luna') },
        { nombre: '/reddit', run: () => handleReddit(sock, from, 'memes') },
        { nombre: '/pin', run: () => handlePinterest(sock, from, 'gatos') },
        { nombre: '/gemini', run: () => handleGemini(sock, from, 'Decime hola en una sola linea', false) },
        { nombre: '/geminiP', run: () => handleGemini(sock, from, 'Decime hola en una sola linea', true) }
    ];
    for (const test of tests) {
        try { await test.run(); } catch (err) {
            await sock.sendMessage(from, { text: `Fallo ${test.nombre}: ${err.message}` });
        }
        await wait(1500);
    }
}

async function pedirCodigo(sock) {
    try {
        const code = await sock.requestPairingCode(HOST_NUMBER);
        const lindo = code?.match(/.{1,4}/g)?.join('-').toUpperCase() || code;
        console.log(`\nCODIGO DE VINCULACION: ${lindo}\n`);
        return lindo;
    } catch (err) {
        console.error('[ERROR] No pude pedir el codigo:', err.message || err);
        codigoSolicitado = false;
        return null;
    }
}

async function startBot() {
    if (sockActivo) {
        try { sockActivo.end(undefined); } catch (_err) {}
        sockActivo = null;
    }
    console.log('[SISTEMA] Conectando a MongoDB Atlas...');
    const mongoClient = new MongoClient(MONGO_URI);
    try {
        await mongoClient.connect();
        console.log('[SISTEMA] MongoDB conectado.');
    } catch (err) {
        console.error('[ERROR] No se pudo conectar a MongoDB.', err);
        return;
    }
    const db = mongoClient.db(DB_NAME);
    const authCollection = db.collection(COLLECTION_NAME);
    banCol = db.collection('baneados');
    try {
        const docs = await banCol.find({}).toArray();
        bannedCache = docs.map((d) => d.numero).filter(Boolean);
    } catch (_err) { bannedCache = []; }
    const { state, saveCreds } = await useMongoDBAuthState(authCollection);
    let version = [2, 3000, 1017551063];
    try { version = (await fetchLatestBaileysVersion()).version; } catch (_err) {
        console.log('[SISTEMA] No pude leer la version de Baileys. Uso la fija.');
    }
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false
    });
    sockActivo = sock;
    sock.ev.on('creds.update', async () => { await saveCreds(); });
    let quotedMsg = null;
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options = {}) => {
        if (content && typeof content === 'object') {
            if (content.text) content.text = `[¡+!]\n${content.text}`;
            else if (content.image && content.caption) content.caption = `[¡+!]\n${content.caption}`;
        }
        if (quotedMsg && !options.quoted && jid === quotedMsg.key?.remoteJid) {
            options = { ...options, quoted: quotedMsg };
        }
        return originalSendMessage(jid, content, options);
    };
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            codigoSolicitado = false;
            const status = lastDisconnect?.error?.output?.statusCode;
            console.log('[SISTEMA] Conexion cerrada. codigo=', status);
            if (status === DisconnectReason.loggedOut || status === 401) {
                try { await authCollection.deleteMany({}); } catch (_err) {}
                setTimeout(() => startBot(), 3000);
                return;
            }
            setTimeout(() => startBot(), 10000);
            return;
        }
        if (connection === 'open') {
            console.log('[SISTEMA] Bot conectado a WhatsApp.');
            codigoSolicitado = false;
            try { await sock.sendPresenceUpdate('unavailable'); } catch (_err) {}
            return;
        }
        if (!sock.authState.creds.registered && !codigoSolicitado && connection !== 'close') {
            codigoSolicitado = true;
            setTimeout(async () => {
                if (sock.authState.creds.registered) { codigoSolicitado = false; return; }
                await pedirCodigo(sock);
            }, 8000);
        }
    });
    sock.ev.on('messages.upsert', async (payload) => {
        try {
            if (payload.type && payload.type !== 'notify') return;
            const msg = payload.messages?.[0];
            if (!msg?.message) return;
            if (yaVisto(msg.key?.id)) return;
            const ts = Number(msg.messageTimestamp || 0);
            if (ts && (Date.now() / 1000 - ts) > 45) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
            if (text.startsWith('[¡+!]')) return;
            if (!text.startsWith('/')) return;
            const from = msg.key.remoteJid;
            const isMe = Boolean(msg.key.fromMe);
            const cleanFrom = normalizarNumero(from);
            const cleanHost = normalizarNumero(HOST_NUMBER);
            const esGrupo = esGrupoJid(from);
            const esChatPrivadoPropio = !esGrupo && (isMe || cleanFrom === cleanHost);
            const isChatAllowed = esChatPrivadoPropio || ALLOWED_CHATS.some((id) => normalizarNumero(id) === cleanFrom);
            if (!isChatAllowed) return;
            quotedMsg = msg;
            const sender = esChatPrivadoPropio ? `${cleanHost}@s.whatsapp.net` : (msg.key.participant || msg.key.remoteJid);
            const parts = text.trim().split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' ');
            const isAdmin = esChatPrivadoPropio || ADMINS.some((admin) => normalizarNumero(admin) === normalizarNumero(sender));
            if (estaBaneado(sender) && !isAdmin) return;
            if (!isAdmin && (!botEnabled || soloAdmins)) return;
            const comandosAdmin = {
                '/status': () => handleStatus(sock, from),
                '/on': async () => { botEnabled = true; await sock.sendMessage(from, { text: 'Bot activado para todos los chats permitidos.' }); },
                '/off': async () => { botEnabled = false; await sock.sendMessage(from, { text: 'Bot apagado. Solo admins pueden usarlo.' }); },
                '/admins': async () => {
                    const modo = args.trim().toLowerCase();
                    if (modo === 'on' || modo === 'si') {
                        soloAdmins = true;
                        await sock.sendMessage(from, { text: 'Modo solo admins ON. El resto no puede usar el bot.' });
                    } else if (modo === 'off' || modo === 'no') {
                        soloAdmins = false;
                        await sock.sendMessage(from, { text: 'Modo solo admins OFF. Los chats permitidos pueden usar el bot.' });
                    } else {
                        await sock.sendMessage(from, { text: `Modo solo admins: ${soloAdmins ? 'ON' : 'OFF'}\nUsa /admins on o /admins off` });
                    }
                },
                '/ban': () => handleBan(sock, from, msg, args),
                '/unban': () => handleUnban(sock, from, msg, args),
                '/baneados': () => handleBaneados(sock, from)
            };
            const comandosPublicos = {
                '/ayuda': () => handleAyuda(sock, from),
                '/help': () => handleAyuda(sock, from),
                '/gemini': () => handleGemini(sock, from, args, false),
                '/geminip': () => handleGemini(sock, from, args, true),
                '/gemini-p': () => handleGemini(sock, from, args, true),
                '/letras': () => handleLetras(sock, from, args),
                '/reddit': () => handleReddit(sock, from, args),
                '/pin': () => handlePinterest(sock, from, args),
                '/ruleta': () => handleRuleta(sock, from, args),
                '/test': () => handleTestCadena(sock, from)
            };
            if (isAdmin && comandosAdmin[command]) { await comandosAdmin[command](); return; }
            if (comandosPublicos[command]) await comandosPublicos[command]();
        } catch (err) {
            console.error('[ERROR MENSAJE]', err);
        }
    });
}

startBot().catch((err) => {
    console.error('[ERROR INICIO]', err);
});
