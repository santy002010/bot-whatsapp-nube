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
const BANNED_FILE = path.join(AUTH_DIR, 'baneados.json');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let botEnabled = true;
let codigoSolicitado = false;

function normalizarNumero(valor) {
    if (!valor) return '';
    return String(valor).replace(/[^0-9]/g, '').replace(/^549/, '54');
}
function getBannedUsers() {
    if (!fs.existsSync(BANNED_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8')); } catch (_err) { return []; }
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function esGrupoJid(jid) {
    const t = String(jid || '');
    return t.includes('@g.us') || t.includes('@broadcast');
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
    const modelo = usarPro ? (process.env.GEMINI_MODEL_PRO || 'gemini-1.5-pro') : (process.env.GEMINI_MODEL || 'gemini-1.5-flash');
    let ultimoError;
    for (let i = 0; i <= reintentos; i++) {
        try {
            const model = genAI.getGenerativeModel({ model: modelo });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (err) {
            ultimoError = err;
            await wait(800 * (i + 1));
        }
    }
    throw ultimoError;
}

async function handleAyuda(sock, from) {
    const texto = ['Comandos disponibles:','/ayuda','/google [texto]','/gemini [texto]','/geminiP [texto]','/letras [cancion]','/pin [texto]','/reddit [texto]','/ruleta [pregunta]','/test','','Solo admin / chat privado: /status  /on  /off'].join('\n');
    await sock.sendMessage(from, { text: texto });
}
async function handleGoogle(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Formato: /google [tu consulta]' });
    const key = process.env.GOOGLE_SEARCH_KEY;
    const cx = process.env.GOOGLE_CX;
    if (!key || !cx) return sock.sendMessage(from, { text: 'Faltan GOOGLE_SEARCH_KEY o GOOGLE_CX en Render.' });
    try {
        const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(args)}&key=${key}&cx=${cx}`;
        const res = await fetch(url);
        const json = await res.json();
        if (!json.items || json.items.length === 0) return sock.sendMessage(from, { text: 'No encontre resultados en Google.' });
        const top = json.items[0];
        await sock.sendMessage(from, { text: `*${top.title}*\n${top.snippet}\n${top.link}` });
    } catch (err) {
        await sock.sendMessage(from, { text: `Error en Google: ${err.message}` });
    }
}
async function handleGemini(sock, from, args, usarPro = false) {
    const comando = usarPro ? '/geminiP' : '/gemini';
    if (!args) return sock.sendMessage(from, { text: `Formato: ${comando} [tu consulta]` });
    try {
        const text = await askGeminiWithRetry(args, usarPro);
        if (!text) return sock.sendMessage(from, { text: 'Gemini no devolvio texto.' });
        await sock.sendMessage(from, { text: `Gemini:\n\n${text.trim()}` });
    } catch (err) {
        await sock.sendMessage(from, { text: `Error en Gemini: ${err.message}` });
    }
}
async function handleLetras(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Formato: /letras [cancion]' });
    try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(args)}`);
        const data = await res.json();
        if (!data || data.length === 0) return sock.sendMessage(from, { text: 'No encontre la letra.' });
        const track = data[0];
        const letra = track.syncedLyrics ? track.syncedLyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim() : track.plainLyrics;
        const cuerpo = `*${track.trackName}* - ${track.artistName}\n\n${letra || 'Sin letra.'}`;
        await sock.sendMessage(from, { text: cuerpo.substring(0, 4000) });
    } catch (_err) {
        await sock.sendMessage(from, { text: 'Error al buscar la letra.' });
    }
}
async function handleReddit(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Formato: /reddit [texto]' });
    try {
        const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&limit=40&raw_json=1`;
        const res = await fetch(url, { headers: { 'User-Agent': 'NodeJS:BotWhatsApp:v2.1.0', Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Reddit respondio HTTP ${res.status}`);
        const json = await res.json();
        const posts = (json?.data?.children || []).map((item) => item.data).filter((post) => post && !post.over_18);
        if (posts.length === 0) return sock.sendMessage(from, { text: 'Sin resultados aptos.' });
        const post = posts[Math.floor(Math.random() * Math.min(15, posts.length))];
        const extra = `\n\nr/${post.subreddit}\nhttps://reddit.com${post.permalink}`;
        const esImagen = post.url && (/\.(jpeg|jpg|gif|png)$/i.test(post.url) || post.url.includes('i.redd.it'));
        if (esImagen) await sock.sendMessage(from, { image: { url: post.url }, caption: `*${post.title}*${extra}` });
        else {
            const texto = post.selftext ? `\n\n${post.selftext.slice(0, 500)}` : '';
            await sock.sendMessage(from, { text: `*${post.title}*${texto}${extra}` });
        }
    } catch (err) {
        await sock.sendMessage(from, { text: `Error con Reddit: ${err.message}. Render a veces bloquea esa web.` });
    }
}
async function handlePinterest(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Formato: /pin [texto]' });
    const key = process.env.GOOGLE_SEARCH_KEY;
    const cx = process.env.GOOGLE_CX || process.env.PINTEREST_CX || 'a24fe245ad6734e91';
    if (!key) return sock.sendMessage(from, { text: 'Falta GOOGLE_SEARCH_KEY en Render.' });
    try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(args)}&searchType=image`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Google Search HTTP ${res.status}`);
        const json = await res.json();
        const items = json.items || [];
        if (items.length === 0) return sock.sendMessage(from, { text: 'No encontre imagenes.' });
        const imagen = items[Math.floor(Math.random() * items.length)].link;
        await sock.sendMessage(from, { image: { url: imagen }, caption: `Busqueda: *${args}*` });
    } catch (err) {
        await sock.sendMessage(from, { text: `Error en el buscador: ${err.message}` });
    }
}
async function handleRuleta(sock, from, args) {
    if (!args) return sock.sendMessage(from, { text: 'Ejemplo: /ruleta Va a llover?\nO con chance: /ruleta Va a llover? 1;2' });
    let pregunta = args, siChance = 1, totalChance = 2, tieneProbabilidad = false;
    const match = args.match(/(\d+);(\d+)\s*$/);
    if (match) {
        siChance = parseInt(match[1], 10);
        totalChance = parseInt(match[2], 10);
        pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();
        tieneProbabilidad = totalChance > 0;
    }
    const numero = Math.floor(Math.random() * (tieneProbabilidad ? totalChance : 2)) + 1;
    const resultado = (tieneProbabilidad ? numero <= siChance : numero === 1) ? 'si' : 'no';
    const extra = tieneProbabilidad ? ` (chance ${siChance};${totalChance})` : '';
    await sock.sendMessage(from, { text: `Ruleta: ${pregunta}\nResultado: *${resultado}*${extra}` });
}
async function handleTestCadena(sock, from) {
    await sock.sendMessage(from, { text: 'Iniciando prueba de comandos...' });
    const tests = [
        { nombre: '/status', run: () => sock.sendMessage(from, { text: 'Operando al 100%.' }) },
        { nombre: '/ruleta', run: () => handleRuleta(sock, from, 'El bot responde? 1;1') },
        { nombre: '/letras', run: () => handleLetras(sock, from, 'Kali Uchis Luna') },
        { nombre: '/reddit', run: () => handleReddit(sock, from, 'memes') },
        { nombre: '/pin', run: () => handlePinterest(sock, from, 'gatos') },
        { nombre: '/google', run: () => handleGoogle(sock, from, 'que dia es hoy') },
        { nombre: '/gemini', run: () => handleGemini(sock, from, 'Hola, como estas?', false) }
    ];
    for (const test of tests) {
        try { await test.run(); } catch (err) {
            await sock.sendMessage(from, { text: `Fallo ${test.nombre}: ${err.message}` });
        }
        await wait(1500);
    }
}

async function startBot() {
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
    sock.ev.on('creds.update', async () => { await saveCreds(); });
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options = {}) => {
        if (content && typeof content === 'object') {
            if (content.text) content.text = `[¡+!]\n${content.text}`;
            else if (content.image && content.caption) content.caption = `[¡+!]\n${content.caption}`;
        }
        if (!esGrupoJid(jid) && options.quoted) delete options.quoted;
        return originalSendMessage(jid, content, options);
    };
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            codigoSolicitado = false;
            const status = lastDisconnect?.error?.output?.statusCode;
            console.log('[SISTEMA] Conexion cerrada. codigo=', status);
            if (status !== DisconnectReason.loggedOut) {
                console.log('[SISTEMA] Reintento en 10 segundos...');
                setTimeout(() => startBot(), 10000);
            } else {
                console.log('[SISTEMA] Sesion cerrada en WhatsApp. Hay que vincular de nuevo.');
            }
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
                try {
                    const code = await sock.requestPairingCode(HOST_NUMBER);
                    const lindo = code?.match(/.{1,4}/g)?.join('-').toUpperCase() || code;
                    console.log(`\nCODIGO DE VINCULACION: ${lindo}\n`);
                } catch (_err) { codigoSolicitado = false; }
            }, 10000);
        }
    });
    sock.ev.on('messages.upsert', async (payload) => {
        try {
            const msg = payload.messages?.[0];
            if (!msg?.message) return;
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
            if (!isChatAllowed) {
                console.log('[IGNORADO]', from, text.slice(0, 40));
                return;
            }
            const sender = esChatPrivadoPropio ? `${cleanHost}@s.whatsapp.net` : (msg.key.participant || msg.key.remoteJid);
            const parts = text.trim().split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' ');
            const isAdmin = esChatPrivadoPropio || ADMINS.some((admin) => normalizarNumero(admin) === normalizarNumero(sender));
            console.log('[CMD]', command, 'from=', from, 'privado=', esChatPrivadoPropio, 'admin=', isAdmin);
            if (getBannedUsers().includes(sender) && !isAdmin) return;
            if (!botEnabled && !isAdmin) return;
            const comandosAdmin = {
                '/status': () => sock.sendMessage(from, { text: 'Operando al 100%.' }),
                '/on': async () => { botEnabled = true; await sock.sendMessage(from, { text: 'Bot activado.' }); },
                '/off': async () => { botEnabled = false; await sock.sendMessage(from, { text: 'Bot desactivado.' }); }
            };
            const comandosPublicos = {
                '/ayuda': () => handleAyuda(sock, from),
                '/help': () => handleAyuda(sock, from),
                '/google': () => handleGoogle(sock, from, args),
                '/gemini': () => handleGemini(sock, from, args, false),
                '/geminip': () => handleGemini(sock, from, args, true),
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
