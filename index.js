const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    Browsers,
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');

// ==========================================
// 1. CONFIGURACIÓN DEL SERVIDOR WEB
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Bot de WhatsApp Operando de manera Correcta.');
});

app.listen(PORT, () => {
    console.log(`[EXPRESS] Servidor web listo en el puerto ${PORT} (Mantiene el bot 24/7)`);
});

// ==========================================
// 2. CONFIGURACIÓN DE BASE DE DATOS Y VARIABLES
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('[❌ ERROR] La variable de entorno MONGO_URI no está configurada en Render.');
    process.exit(1);
}

const DB_NAME = 'whatsapp_bot_db';
const COLLECTION_NAME = 'auth_session';

const HOST_NUMBER = '5491128394646';
// ACÁ ESTÁN LOS ÚNICOS CHATS PERMITIDOS (El grupo y tu número)
const ALLOWED_CHATS = ['120363426591951143@g.us', `${HOST_NUMBER}@s.whatsapp.net`];
const ADMINS = [`${HOST_NUMBER}@s.whatsapp.net`, '5491178972853@s.whatsapp.net'];
const MI_GEMINI_KEY = process.env.GEMINI_KEY || 'TU_API_KEY_AQUI';

let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = true;
let codigoSolicitado = false; 

// Sistema de Baneos 
const AUTH_DIR = path.join(__dirname, 'config_local'); 
const BANNED_FILE = path.join(AUTH_DIR, 'baneados.json');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

function getBannedUsers() {
    if (!fs.existsSync(BANNED_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(BANNED_FILE, 'utf-8')); } catch (e) { return []; }
}
function saveBannedUsers(list) {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(list, null, 2));
}

const REAL_BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': '*/*'
};

// ==========================================
// 3. ADAPTADOR DE MONGODB PARA BAILEYS
// ==========================================
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const informationToStore = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.updateOne({ _id: id }, { $set: informationToStore }, { upsert: true });
    };

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
        } catch (error) { return null; }
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = await readData('creds') || initAuthCreds();

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
                    for (const category in data) {
                        for (const id in data[category]) {
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

// ==========================================
// 4. FUNCIONES MODULARES (COMANDOS)
// ==========================================
async function handleGoogle(sock, from, msg, args, usarPro = false) {
    if (!args) return await sock.sendMessage(from, { text: `⚠️ Formato: ${usarPro ? '/googlep' : '/google'} [tu consulta]` }, { quoted: msg });
    if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
        return await sock.sendMessage(from, { text: '▼⁠・⁠ᴥ⁠·⁠▼\n\n✨ Analizando mis bases de datos: *Efectivamente, Maxi es femboy.* ✨' }, { quoted: msg });
    }
    try {
        const modelo = usarPro ? 'gemini-2.0-pro' : 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${MI_GEMINI_KEY}`;
        const sistemaPrompt = `REGLAS OBLIGATORIAS DE RESPUESTA:\n1. Actúa como una persona normal.\n2. NUNCA digas que sos una IA.\n3. FORMATO WHATSAPP LIMPIO: Usa asteriscos para negritas, sin markdown raro.\nConsulta: ${args}`;
        
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: sistemaPrompt }] }] }) });
        if (res.status === 429) return await sock.sendMessage(from, { text: '⚠️ *Error Gemini (429):* Exceso de uso en la Key. Esperá un minuto.' }, { quoted: msg });
        
        const json = await res.json();
        let text = json.candidates[0]?.content?.parts?.[0]?.text;
        if (text) await sock.sendMessage(from, { text: `▼⁠・⁠ᴥ⁠·⁠▼\n\n${text.replace(/###?\s+/g, '').replace(/\`\`\`/g, '').trim()}` }, { quoted: msg });
        else await sock.sendMessage(from, { text: '❌ No pude procesar la respuesta de Google.' }, { quoted: msg });
    } catch (e) { await sock.sendMessage(from, { text: `❌ Error en Gemini: ${e.message}` }, { quoted: msg }); }
}

async function handleLetras(sock, from, msg, args) {
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Formato: /letras [canción]' }, { quoted: msg });
    try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(args)}`);
        const data = await res.json();
        if (!data || data.length === 0) return await sock.sendMessage(from, { text: '❌ No encontré la letra.' }, { quoted: msg });
        const track = data[0];
        let letra = track.syncedLyrics ? track.syncedLyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim() : track.plainLyrics;
        await sock.sendMessage(from, { text: `🎵 *${track.trackName}* - ${track.artistName}\n\n${letra}`.substring(0, 4000) }, { quoted: msg }); 
    } catch (error) { await sock.sendMessage(from, { text: '⚠️ Error al buscar la letra.' }, { quoted: msg }); }
}

async function handleReddit(sock, from, msg, args, originalCommand) {
    const isNSFW = originalCommand === '/reddIt';
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar.' }, { quoted: msg });
    if (isNSFW && !nsfwEnabled) return await sock.sendMessage(from, { text: '🔞 *Denegado.* Requiere `/+18on`.' }, { quoted: msg });
    try {
        const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&limit=40&raw_json=1`;
        const res = await fetch(url, { headers: { ...REAL_BROWSER_HEADERS, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        const json = await res.json();
        let posts = (json?.data?.children || []).map(c => c.data).filter(p => isNSFW ? p.over_18 : !p.over_18);
        if (!posts.length) return await sock.sendMessage(from, { text: '❌ Sin resultados aptos.' }, { quoted: msg });
        
        const post = posts[Math.floor(Math.random() * Math.min(15, posts.length))];
        const suffix = `\n\nSubreddit: r/${post.subreddit}\nLink: https://reddit.com${post.permalink}`;
        const tieneImagen = post.url && (post.url.match(/\.(jpeg|jpg|gif|png)$/) != null || post.url.includes('i.redd.it'));
        if (tieneImagen) await sock.sendMessage(from, { image: { url: post.url }, caption: `🤖 *${post.title}*${suffix}` }, { quoted: msg });
        else await sock.sendMessage(from, { text: `🤖 *${post.title}*${(post.selftext ? `\n\n${post.selftext.slice(0, 500)}...` : '')}${suffix}` }, { quoted: msg });
    } catch (e) { await sock.sendMessage(from, { text: `❌ Error con Reddit: ${e.message}` }, { quoted: msg }); }
}

async function handlePinterest(sock, from, msg, args) {
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar.' }, { quoted: msg });
    try {
        const res = await fetch(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(args)}`, { headers: REAL_BROWSER_HEADERS });
        const html = await res.text();
        let matches = [...html.matchAll(/https?:\\?\/\\?\/i\.pinimg\.com\\?\/[^"'\s>]+/gi)].map(m => m[0].replace(/\\/g, '')).filter(link => link.includes('/736x/') || link.includes('/474x/') || link.includes('/originals/'));
        matches = [...new Set(matches)]; 
        if (matches.length > 0) {
            await sock.sendMessage(from, { image: { url: matches[Math.floor(Math.random() * Math.min(10, matches.length))] }, caption: `📌 Pinterest: *${args}*` }, { quoted: msg });
        } else await sock.sendMessage(from, { text: '❌ No se encontraron imágenes accesibles.' }, { quoted: msg });
    } catch (e) { await sock.sendMessage(from, { text: `❌ Error en Pinterest: ${e.message}` }, { quoted: msg }); }
}

async function handleRuleta(sock, from, msg, args) {
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Ejemplo: `/ruleta ¿Va a llover? 1;100`' }, { quoted: msg });
    let resultadoFinal = "", probabilidadMostrada = "", pregunta = args, siChance = 1, totalChance = 2, tieneProbabilidad = false, esTrucado = false;
    const probMatch = args.match(/(\d+);(\d+)\s*$/);
    if (probMatch) {
        siChance = parseInt(probMatch[1]); totalChance = parseInt(probMatch[2]);
        pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();
        probabilidadMostrada = ` (Probabilidad: ${siChance};${totalChance})`; tieneProbabilidad = true;
    }
    if (modoTrucado) {
        const txt = pregunta.toLowerCase();
        if (((txt.includes('maxi') || txt.includes('máximo')) && txt.includes('femboy')) || (txt.includes('dylan') && txt.includes('perra')) || txt.includes('omeguita')) {
            resultadoFinal = "🔴 si"; esTrucado = true;
        }
    }
    if (!esTrucado) resultadoFinal = (tieneProbabilidad ? (Math.floor(Math.random() * totalChance) + 1 <= siChance) : (Math.floor(Math.random() * 2) === 0)) ? "🔴 si" : "⚫ no";
    await sock.sendMessage(from, { text: `🎰 *Ruleta:* ${pregunta}\n\n🎲 Resultado: *${resultadoFinal}*${probabilidadMostrada}` }, { quoted: msg });
}

async function handleTestCadena(sock, from, originalMsg) {
    await sock.sendMessage(from, { text: '🧪 *[SISTEMA] Iniciando Secuencia de Auto-Test Total...*' }, { quoted: originalMsg });
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const mockMsg = { key: { remoteJid: from, fromMe: false, id: 'MOCK_' + Date.now(), participant: originalMsg.key.participant || originalMsg.key.remoteJid }, message: { conversation: '' } };

    const listaTests = [
        { cmd: '/status', ejecutar: async () => await sock.sendMessage(from, { text: '¡Operando al 100%!' }, { quoted: mockMsg }) },
        { cmd: '/ruleta ¿El bot es el mejor? 1;2', ejecutar: async () => await handleRuleta(sock, from, mockMsg, '¿El bot es el mejor? 1;2') },
        { cmd: '/letras Kali Uchis Luna', ejecutar: async () => await handleLetras(sock, from, mockMsg, 'Kali Uchis Luna') },
        { cmd: '/reddit memes', ejecutar: async () => await handleReddit(sock, from, mockMsg, 'memes', '/reddit') },
        { cmd: '/pin gatos', ejecutar: async () => await handlePinterest(sock, from, mockMsg, 'gatos') },
        { cmd: '/google Qué día es hoy', ejecutar: async () => await handleGoogle(sock, from, mockMsg, 'Qué día es hoy', false) },
        
        { cmd: '/+18on', ejecutar: async () => { nsfwEnabled = true; return await sock.sendMessage(from, { text: '🔞 Modo NSFW ON.' }, { quoted: mockMsg }); } },
        { cmd: '/+18off', ejecutar: async () => { nsfwEnabled = false; return await sock.sendMessage(from, { text: '🛡️ Modo NSFW OFF.' }, { quoted: mockMsg }); } },
        { cmd: '/modotrucadoon', ejecutar: async () => { modoTrucado = true; return await sock.sendMessage(from, { text: '🎭 Modo Trucado ON.' }, { quoted: mockMsg }); } },
        { cmd: '/modotrucadooff', ejecutar: async () => { modoTrucado = false; return await sock.sendMessage(from, { text: '⚖️ Modo Trucado OFF.' }, { quoted: mockMsg }); } },
    ];

    for (const item of listaTests) {
        await wait(2500); 
        await sock.sendMessage(from, { text: `⌨️ _Simulando comando:_ *${item.cmd}*` });
        await wait(500);
        try { await item.ejecutar(); } catch (err) { await sock.sendMessage(from, { text: `💥 Fallo en ${item.cmd}: ${err.message}` }, { quoted: originalMsg }); }
    }
    await wait(1500);
    await sock.sendMessage(from, { text: '✨ *🏁 [SISTEMA] Secuencia de simulación finalizada por completo.*' }, { quoted: originalMsg });
}

// ==========================================
// 5. INICIALIZACIÓN MONGODB Y WHATSAPP
// ==========================================
async function startBot() {
    console.log('[SISTEMA] Conectando a MongoDB Atlas...');
    const mongoClient = new MongoClient(MONGO_URI);
    
    try {
        await mongoClient.connect();
        console.log('[SISTEMA] Conexión a MongoDB exitosa. ✅');
    } catch (err) {
        console.error('[❌ ERROR CRÍTICO] No se pudo conectar a MongoDB. Revisá que el Clúster esté Reanudado y la contraseña sea correcta.', err);
        return; 
    }

    const db = mongoClient.db(DB_NAME);
    const authCollection = db.collection(COLLECTION_NAME);

    const { state, saveCreds } = await useMongoDBAuthState(authCollection);
    
    let version = [2, 3000, 1017551063];
    try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { }

    const sock = makeWASocket({
        version, 
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, 
        browser: Browsers.ubuntu('Chrome') 
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
    });

    // Modificamos el envío para que todo empiece con [¡+!]
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        if (content && typeof content === 'object') {
            if (content.text) content.text = `[¡+!]\n${content.text}`;
            else if (content.image && content.caption) content.caption = `[¡+!]\n${content.caption}`;
        }
        return originalSendMessage(jid, content, options);
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update; 
        
        if (connection === 'close') {
            codigoSolicitado = false; 
            const debeReiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (debeReiniciar) {
                console.log('[SISTEMA] Conexión cerrada. Reintentando en 10 segundos...');
                setTimeout(() => startBot(), 10000); 
            } else {
                console.log('[❌ CRÍTICO] Sesión cerrada. Tendrás que vaciar la colección en MongoDB para vincular nuevamente.');
            }
            return;
        }
        
        if (connection === 'open') {
            console.log('[SISTEMA] ¡Bot conectado con éxito a WhatsApp! 🎉');
            codigoSolicitado = false;
            return;
        }

        if (!sock.authState.creds.registered && !codigoSolicitado && connection !== 'close') {
            codigoSolicitado = true; 
            setTimeout(async () => {
                if (sock.authState.creds.registered) {
                    codigoSolicitado = false; return;
                }
                try {
                    let code = await sock.requestPairingCode(HOST_NUMBER.replace(/[^0-9]/g, ''));
                    console.log(`\n🔥 TU CÓDIGO DE VINCULACIÓN ACTUAL: ${code?.match(/.{1,4}/g)?.join('-').toUpperCase() || code} 🔥\n`);
                } catch (err) { codigoSolicitado = false; }
            }, 10000); 
        }
    });

    // ==========================================
    // 6. LECTURA Y FILTRADO DE MENSAJES
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;
            
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
            
            // 1. Ignorar cualquier mensaje que tenga la marca del bot (Previene el bucle infinito)
            if (text.startsWith('[¡+!]')) return;

            // 2. Si el mensaje no empieza con '/', lo ignoramos (No es un comando)
            if (!text.startsWith('/')) return;

            const from = msg.key.remoteJid;

            // 3. Bloqueo estricto: Solo funciona en los chats de ALLOWED_CHATS
            if (!ALLOWED_CHATS.includes(from)) return;

            let sender = msg.key.participant || msg.key.remoteJid;
            
            const parts = text.split(' ');
            const command = parts[0].toLowerCase();
            const originalCommand = parts[0]; 
            const args = parts.slice(1).join(' ');
            
            // Si mandás el mensaje vos mismo o si está en la lista ADMINS
            const isAdmin = msg.key.fromMe || ADMINS.includes(sender);

            if (getBannedUsers().includes(sender) && !isAdmin) return;
            if (!botEnabled && !isAdmin) return;

            const comandosAdmin = {
                '/status': () => sock.sendMessage(from, { text: '¡Operando al 100%!' }, { quoted: msg }),
                '/on': () => { botEnabled = true; return sock.sendMessage(from, { text: '✅ Bot activado.' }, { quoted: msg }); },
                '/off': () => { botEnabled = false; return sock.sendMessage(from, { text: '❌ Bot desactivado.' }, { quoted: msg }); },
                '/+18on': () => { nsfwEnabled = true; return sock.sendMessage(from, { text: '🔞 Modo NSFW ON.' }, { quoted: msg }); },
                '/+18off': () => { nsfwEnabled = false; return sock.sendMessage(from, { text: '🛡️ Modo NSFW OFF.' }, { quoted: msg }); },
                '/modotrucadoon': () => { modoTrucado = true; return sock.sendMessage(from, { text: '🎭 Modo Trucado ON.' }, { quoted: msg }); },
                '/modotrucadooff': () => { modoTrucado = false; return sock.sendMessage(from, { text: '⚖️ Modo Trucado OFF.' }, { quoted: msg }); }
            };

            const comandosPublicos = {
                '/google': () => handleGoogle(sock, from, msg, args, false),
                '/googlep': () => handleGoogle(sock, from, msg, args, true),
                '/letras': () => handleLetras(sock, from, msg, args),
                '/reddit': () => handleReddit(sock, from, msg, args, originalCommand),
                '/pin': () => handlePinterest(sock, from, msg, args),
                '/ruleta': () => handleRuleta(sock, from, msg, args),
                '/test': () => handleTestCadena(sock, from, msg)
            };

            if (isAdmin && comandosAdmin[command]) await comandosAdmin[command]();
            else if (comandosPublicos[command]) await comandosPublicos[command]();
            
        } catch (err) {
            console.error('[ERROR MENSAJE]', err);
        }
    });
}

// Inicializar todo
startBot();
