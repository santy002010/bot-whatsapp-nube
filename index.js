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

async function handleGoogle(sock, from, msg, args) {
    if (!args) return await sock.sendMessage(from, { text: `⚠️ Formato: /google [tu consulta]` }, { quoted: msg });

    try {
        const searchUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(args)}&key=${process.env.GOOGLE_SEARCH_KEY}&cx=${process.env.GOOGLE_CX}`;
        const res = await fetch(searchUrl);
        const json = await res.json();

        if (json.items && json.items.length > 0) {
            const top = json.items[0];
            await sock.sendMessage(from, { text: `🔎 *${top.title}*\n${top.snippet}\n${top.link}` }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { text: '❌ No encontré resultados en Google.' }, { quoted: msg });
        }
    } catch (e) {
        await sock.sendMessage(from, { text: `❌ Error en Google: ${e.message}` }, { quoted: msg });
    }
}

async function handleGemini(sock, from, msg, args, usarPro = false) {
    if (!args) return await sock.sendMessage(from, { text: `⚠️ Formato: ${usarPro ? '/geminiP' : '/gemini'} [tu consulta]` }, { quoted: msg });

    try {
        const sistemaPrompt = `Consulta en WhatsApp: ${args}`;
        const text = await askGeminiWithRetry(sistemaPrompt, usarPro);

        if (text) {
            await sock.sendMessage(from, { text: `🤖 Gemini:\n\n${text.trim()}` }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { text: '❌ No pude procesar la respuesta de Gemini.' }, { quoted: msg });
        }
    } catch (e) {
        await sock.sendMessage(from, { text: `❌ Error en Gemini: ${e.message}` }, { quoted: msg });
    }
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
    const isNSFW = originalCommand === '/reddit'; // Mantengo tu lógica de minúsculas/mayúsculas si la tenías así
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar.' }, { quoted: msg });
    if (isNSFW && !nsfwEnabled) return await sock.sendMessage(from, { text: '🔞 *Denegado.* Requiere `/+18on`.' }, { quoted: msg });
    
    try {
        const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&limit=40&raw_json=1`;
        
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': 'NodeJS:BotWhatsApp:v2.0.0 (by /u/santu2098)',
                'Accept': 'application/json'
            } 
        });

        if (!res.ok) throw new Error(`Bloqueo de red (HTTP ${res.status})`);

        const json = await res.json();
        let posts = (json?.data?.children || []).map(c => c.data).filter(p => isNSFW ? p.over_18 : !p.over_18);
        
        if (!posts.length) return await sock.sendMessage(from, { text: '❌ Sin resultados aptos.' }, { quoted: msg });
        
        const post = posts[Math.floor(Math.random() * Math.min(15, posts.length))];
        const suffix = `\n\nSubreddit: r/${post.subreddit}\nLink: https://reddit.com${post.permalink}`;
        const tieneImagen = post.url && (post.url.match(/\.(jpeg|jpg|gif|png)$/) != null || post.url.includes('i.redd.it'));
        
        if (tieneImagen) {
            await sock.sendMessage(from, { image: { url: post.url }, caption: `🤖 *${post.title}*${suffix}` }, { quoted: msg });
        } else {
            const texto = post.selftext ? `\n\n${post.selftext.slice(0, 500)}...` : '';
            await sock.sendMessage(from, { text: `🤖 *${post.title}*${texto}${suffix}` }, { quoted: msg });
        }
    } catch (e) { 
        await sock.sendMessage(from, { text: `❌ Error con Reddit: ${e.message}. Puede que Render siga bloqueado.` }, { quoted: msg }); 
    }
}

async function handlePinterest(sock, from, msg, args) {
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar.' }, { quoted: msg });
    
    // Llamamos a la variable de entorno (Tenés que crearla en Render)
    const GOOGLE_SEARCH_KEY = process.env.GOOGLE_SEARCH_KEY;
    // Tu ID de buscador personalizado (CSE)
    const CX_ID = 'a24fe245ad6734e91'; 

    if (!GOOGLE_SEARCH_KEY) {
        return await sock.sendMessage(from, { text: '❌ Falta configurar la variable `Google Search_KEY` en Render para usar este buscador.' }, { quoted: msg });
    }

    try {
        const query = encodeURIComponent(args);
        // Atacamos la API de Google Custom Search pidiendo específicamente imágenes (searchType=image)
        const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_KEY}&cx=${CX_ID}&q=${query}&searchType=image`;

        const res = await fetch(url);
        
        if (!res.ok) {
            throw new Error(`Google Search bloqueó la petición (HTTP ${res.status}). Revisá tu API Key.`);
        }

        const json = await res.json();
        const items = json.items || [];

        if (items.length > 0) {
            // Google suele devolver 10 resultados. Elegimos uno al azar para variar.
            const imagenElegida = items[Math.floor(Math.random() * items.length)].link;
            await sock.sendMessage(from, { image: { url: imagenElegida }, caption: `📌 Búsqueda: *${args}*` }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { text: '❌ No se encontraron imágenes para esa búsqueda.' }, { quoted: msg });
        }
    } catch (e) { 
        await sock.sendMessage(from, { text: `❌ Error en el buscador: ${e.message}` }, { quoted: msg }); 
    }
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

    // 🔎 Google Search
    { cmd: '/google Qué día es hoy', ejecutar: async () => await handleGoogle(sock, from, mockMsg, 'Qué día es hoy') },

    // 🤖 Gemini
    { cmd: '/gemini Hola, ¿cómo estás?', ejecutar: async () => await handleGemini(sock, from, mockMsg, 'Hola, ¿cómo estás?', false) },
    { cmd: '/geminiP Explicame la teoría de cuerdas', ejecutar: async () => await handleGemini(sock, from, mockMsg, 'Explicame la teoría de cuerdas', true) },

    { cmd: '/+18on', ejecutar: async () => { nsfwEnabled = true; return await sock.sendMessage(from, { text: '🔞 Modo NSFW ON.' }, { quoted: mockMsg }); } },
    { cmd: '/+18off', ejecutar: async () => { nsfwEnabled = false; return await sock.sendMessage(from, { text: '🛡️ Modo NSFW OFF.' }, { quoted: mockMsg }); } },
    { cmd: '/modotrucadoon', ejecutar: async () => { modoTrucado = true; return await sock.sendMessage(from, { text: '🎭 Modo Trucado ON.' }, { quoted: mockMsg }); } },
    { cmd: '/modotrucadooff', ejecutar: async () => { modoTrucado = false; return await sock.sendMessage(from, { text: '⚖️ Modo Trucado OFF.' }, { quoted: mockMsg }); } },
];

// ==========================================
// FUNCIÓN AUXILIAR: Normalizar números de Argentina
// ==========================================
// Borra '+', espacios y transforma '549' en '54' para que las comparaciones sean idénticas
const normalizarNumero = (num) => {
    if (!num) return '';
    return num.replace(/[^0-9]/g, '').replace(/^549/, '54');
};

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
        console.error('[❌ ERROR CRÍTICO] No se pudo conectar a MongoDB.', err);
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

    // Modificamos el envío para añadir la marca [¡+!] y solucionar el bug de responderse a uno mismo
    const originalSendMessage = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        if (content && typeof content === 'object') {
            if (content.text) content.text = `[¡+!]\n${content.text}`;
            else if (content.image && content.caption) content.caption = `[¡+!]\n${content.caption}`;
        }
        
        // SOLUCIÓN AL BUG DEL CHAT PRIVADO: Si nos hablamos a nosotros mismos, quitamos el 'quoted'
        const cleanJid = normalizarNumero(jid);
        const cleanHost = normalizarNumero(HOST_NUMBER);
        if (cleanJid === cleanHost && options && options.quoted) {
            delete options.quoted;
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
            } return;
        }
        
        if (connection === 'open') {
            console.log('[SISTEMA] ¡Bot conectado con éxito a WhatsApp! 🎉');
            codigoSolicitado = false;
            return;
        }

        if (!sock.authState.creds.registered && !codigoSolicitado && connection !== 'close') {
            codigoSolicitado = true; 
            setTimeout(async () => {
                if (sock.authState.creds.registered) { codigoSolicitado = false; return; }
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
            
            if (text.startsWith('[¡+!]')) return;
            if (!text.startsWith('/')) return;

            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe; 

            // Normalización ultra-segura de los números
            const cleanFrom = normalizarNumero(from);
            const cleanHost = normalizarNumero(HOST_NUMBER);
            const isSelfChat = cleanFrom === cleanHost;

            // Filtro de chats: pasa si eres tú (isMe), tu propio chat privado (isSelfChat) o está en ALLOWED_CHATS
            const isChatAllowed = isMe || isSelfChat || ALLOWED_CHATS.some(id => normalizarNumero(id) === cleanFrom);
            
            if (!isChatAllowed) return;

            // Definimos el sender real
            let sender = (isMe || isSelfChat) ? `${cleanHost}@s.whatsapp.net` : (msg.key.participant || msg.key.remoteJid);
            
            const parts = text.split(' ');
            const command = parts[0].toLowerCase();
            const originalCommand = parts[0]; 
            const args = parts.slice(1).join(' ');
            
            const cleanSender = normalizarNumero(sender);
            const isAdmin = isMe || isSelfChat || ADMINS.some(admin => normalizarNumero(admin) === cleanSender);

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
    '/google': () => handleGoogle(sock, from, msg, args),
    '/gemini': () => handleGemini(sock, from, msg, args, false),
    '/geminiP': () => handleGemini(sock, from, msg, args, true),
    '/letras': () => handleLetras(sock, from, msg, args),
    '/reddit': () => handleReddit(sock, from, msg, args, originalCommand),
    '/pin': () => handlePinterest(sock, from, msg, args),
    '/ruleta': () => handleRuleta(sock, from, msg, args),
    '/test': () => handleTestCadena(sock, from, msg)
};

if (isAdmin && comandosAdmin[command]) {
    await comandosAdmin[command]();
} else if (comandosPublicos[command]) {
    await comandosPublicos[command]();
}

} catch (err) {
    console.error('[ERROR MENSAJE]', err);
}
}); // 👈 cierre del sock.ev.on('messages.upsert', ...)

startBot(); // 👈 inicio del bot