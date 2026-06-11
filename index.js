const {
    default: makeWASocket,
    Browsers,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    BufferJSON,       
    initAuthCreds,    
    proto             
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb'); 
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const express = require('express');
const NodeCache = require('node-cache');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ==================== CONFIGURACIÓN ====================
const PORT = process.env.PORT || 10000;
const GRUPO_PERMITIDO = '120363426591951143@g.us';
const ADMINS_RAW = ['5491128394646', '5491178972853'];
const ADMINS = ADMINS_RAW.map(a => `${a}@s.whatsapp.net`);
const HOST_ADMIN = '5491128394646@s.whatsapp.net';
const GEMINI_API_KEY = 'AIzaSyAxeWKyd8nR6GFrhHg7XBmq2cWwCPVyADI';
const BAN_FILE = './session/baneados.json';
const SESSION_DIR = './session';

// Estado Global
let botActivo = true;
let modoNSFW = false;
let modoTrucado = false;
let baneados = [];
let pairingCodeRequested = false;

// Caché para evitar spam de comandos
const msgCache = new NodeCache({ stdTTL: 10, checkperiod: 120 });

// 🔑 --- FUNCIÓN PARA GUARDAR LA SESIÓN EN LA NUBE ---
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.replaceOne({ _id: id }, serialized, { upsert: true });
    };

    const readData = async (id) => {
        try {
            const document = await collection.findOne({ _id: id });
            if (!document) return null;
            return JSON.parse(JSON.stringify(document), BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) {}
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        }
    };
}

// ==================== INICIALIZAR EXPRESS ====================
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Bot está corriendo perfectamente.');
});

app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        botActivo,
        modoNSFW,
        modoTrucado,
        baneados: baneados.length,
        adminCount: ADMINS.length
    });
});

const server = app.listen(PORT, () => {
    console.log(`[SERVIDOR] Express corriendo en el puerto ${PORT}`);
    fs.ensureDirSync(SESSION_DIR);
    cargarBaneados();
});

// ==================== GEMINI AI ====================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const modelFlash = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const modelPro = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// ==================== FUNCIONES AUXILIARES DE CONTROL ====================
function cargarBaneados() {
    try {
        if (fs.existsSync(BAN_FILE)) {
            baneados = fs.readJSONSync(BAN_FILE);
            console.log(`[BANEADOS] Cargados ${baneados.length} baneados.`);
        } else {
            fs.writeJSONSync(BAN_FILE, []);
            baneados = [];
        }
    } catch (e) {
        console.error("[ERROR] No se pudo cargar baneados.json", e);
        baneados = [];
    }
}

function guardarBaneados() {
    try {
        fs.ensureDirSync(SESSION_DIR);
        fs.writeJSONSync(BAN_FILE, baneados);
    } catch (e) {
        console.error("[ERROR] No se pudo guardar baneados.json", e);
    }
}

function limpiarJid(jid) {
    if (!jid) return '';
    let limpio = jid.split(':')[0];
    return limpio.includes('@') ? limpio : `${limpio}@s.whatsapp.net`;
}

function esAdmin(jid, msg) {
    if (msg?.key?.fromMe) return true;
    return ADMINS.includes(jid);
}

function estaBaneado(jid) {
    return baneados.includes(jid);
}

function getCaption(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage) return message.extendedTextMessage.text;
    if (message.imageMessage) return message.imageMessage.caption;
    if (message.videoMessage) return message.videoMessage.caption;
    return '';
}

function formatearRespuesta(texto) {
    if (texto.trim().startsWith('[¡+!]')) return texto;
    return `[¡+!]\n${texto}`;
}

function limpiarRespuestaIA(texto) {
    return texto.replace(/ia:/gi, '').trim();
}

// ==================== HANDLERS DE COMANDOS ====================

async function handleStatus(sock, msg, chatId, senderJid) {
    if (!esAdmin(senderJid, msg)) return;
    await sock.sendMessage(chatId, { 
        text: formatearRespuesta(`✅ Bot operativo.\nGrupo Permitido: Macheado correctamente\nActivo: ${botActivo}\n+18: ${modoNSFW}\nTrucado: ${modoTrucado}`) 
    });
}

async function handleToggle(sock, msg, chatId, senderJid, comando) {
    if (!esAdmin(senderJid, msg)) return;

    switch(comando) {
        case 'on': botActivo = true; break;
        case 'off': botActivo = false; break;
        case '+18on': modoNSFW = true; break;
        case '+18off': modoNSFW = false; break;
        case 'modotrucadoon': modoTrucado = true; break;
        case 'modotrucadooff': modoTrucado = false; break;
    }

    await sock.sendMessage(chatId, { 
        text: formatearRespuesta(`✅ Modo actualizado: ${comando}`) 
    });
}

async function handleBan(sock, msg, chatId, senderJid, accion) {
    if (!esAdmin(senderJid, msg)) return;

    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!quoted) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⚠️ Tenés que responder a un mensaje del usuario a banear/desbanear.') 
        });
        return;
    }

    const targetJid = limpiarJid(quoted);
    if (!targetJid) return;

    if (esAdmin(targetJid, null)) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⛔ No podés banear a un administrador del bot.') 
        });
        return;
    }

    if (accion === 'ban') {
        if (!estaBaneado(targetJid)) {
            baneados.push(targetJid);
            guardarBaneados();
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta(`🚫 Usuario baneado: @${targetJid.split('@')[0]}`), 
                mentions: [targetJid] 
            });
        } else {
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta('⚠️ Ese usuario ya estaba baneado.') 
            });
        }
    } else {
        baneados = baneados.filter(b => limpiarJid(b).split('@')[0] !== targetJid.split('@')[0]);
        guardarBaneados();
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta(`✅ Usuario desbaneado: @${targetJid.split('@')[0]}`), 
            mentions: [targetJid] 
        });
    }
}

async function handleRuleta(sock, msg, senderJid, chatId, texto) {
    if (!botActivo && !esAdmin(senderJid, msg)) return;
    if (estaBaneado(senderJid) && !esAdmin(senderJid, msg)) return;

    const args = texto.split(' ');
    const idxProb = args.findIndex(a => a.includes(';'));
    if (idxProb === -1) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('Formato: /ruleta [pregunta] [X;Y] (ej: 1;10)') 
        });
        return;
    }

    const pregunta = args.slice(1, idxProb).join(' ').toLowerCase();
    const probRaw = args[idxProb];
    const [chancesSi, totalChances] = probRaw.split(';').map(Number);

    if (isNaN(chancesSi) || isNaN(totalChances) || chancesSi <= 0 || totalChances <= 0 || chancesSi > totalChances) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⚠️ Formato inválido. X debe ser menor o igual a Y, y ambos positivos (ej: 1;10)') 
        });
        return;
    }

    if (modoTrucado) {
        if (pregunta.includes('maxi') && pregunta.includes('femboy')) {
            return await sock.sendMessage(chatId, { text: formatearRespuesta('🔴 si') });
        }
        if (pregunta.includes('dylan') && pregunta.includes('perra')) {
            return await sock.sendMessage(chatId, { text: formatearRespuesta('🔴 si') });
        }
        if (pregunta.includes('omeguita')) {
            return await sock.sendMessage(chatId, { text: formatearRespuesta('🔴 si') });
        }
    }

    const numeroAleatorio = Math.floor(Math.random() * totalChances) + 1;
    const resultado = numeroAleatorio <= chancesSi ? '🔴 si' : '⚫ no';

    await sock.sendMessage(chatId, { text: formatearRespuesta(resultado) });
}

async function handleGoogle(sock, msg, senderJid, chatId, texto, esNSFW) {
    if (!botActivo && !esAdmin(senderJid, msg)) return;
    if (estaBaneado(senderJid) && !esAdmin(senderJid, msg)) return;

    if (esNSFW && !modoNSFW) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⛔ Modo +18 desactivado.') 
        });
        return;
    }

    const query = texto.split(' ').slice(1).join(' ').trim();
    if (!query) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('Formato: /google [búsqueda]') 
        });
        return;
    }

    if (modoTrucado && query.toLowerCase().includes('maxi') && query.toLowerCase().includes('femboy')) {
        return await sock.sendMessage(chatId, { 
            text: formatearRespuesta('▼⁠・⁠ᴥ⁠·⁠▼\nMaxi es definitivamente un femboy, confirmado.') 
        });
    }

    try {
        const modeloUsar = esNSFW ? modelPro : modelFlash;
        const prompt = `Responde de manera completa a esta consulta. No uses etiquetas, no menciones que sos una IA, no pongas prefijos. Solo la respuesta directa: ${query}`;
        const result = await modeloUsar.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        text = limpiarRespuestaIA(text);

        await sock.sendMessage(chatId, { 
            text: formatearRespuesta(`▼⁠・⁠ᴥ⁠·⁠▼\n${text}`) 
        });
    } catch (error) {
        console.error('[GEMINI ERROR]', error);
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⚠️ Error al conectar con Gemini.') 
        });
    }
}

async function handleReddit(sock, msg, senderJid, chatId, texto, isNSFW) {
    if (!botActivo && !esAdmin(senderJid, msg)) return;
    if (estaBaneado(senderJid) && !esAdmin(senderJid, msg)) return;

    if (isNSFW && !modoNSFW) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⛔ El comando /reddIt requiere modo +18 activado. Usá /+18on para activarlo.') 
        });
        return;
    }

    const subreddit = texto.split(' ')[1]?.trim();
    if (!subreddit) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('Formato: /reddit [subreddit]') 
        });
        return;
    }

    try {
        const url = `https://api.pullpush.io/reddit/search/submission/?subreddit=${subreddit}&size=50&sort=desc&over_18=${isNSFW}`;
        const { data } = await axios.get(url, { timeout: 10000 });

        if (!data.data || data.data.length === 0) {
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta('No se encontraron posts en ese subreddit.') 
            });
            return;
        }

        const posts = data.data.filter(p => {
            const url = p.url || '';
            return url.match(/\.(jpg|jpeg|png|gif|mp4)$/i) || 
                   url.includes('imgur.com') || 
                   url.includes('redd.it') ||
                   url.includes('i.redd.it');
        });

        if (posts.length === 0) {
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta('No hay imágenes/videos disponibles en este momento.') 
            });
            return;
        }

        const post = posts[Math.floor(Math.random() * posts.length)];
        const caption = `📱 r/${subreddit}\n📝 ${post.title || 'Sin título'}\n⬆️ ${post.score} | 💬 ${post.num_comments}\n🔗 u/${post.author}`;

        const mediaUrl = post.url_overridden_by_dest || post.url;

        if (mediaUrl.match(/\.(mp4|gifv)$/i) || mediaUrl.includes('v.redd.it')) {
            await sock.sendMessage(chatId, { 
                video: { url: mediaUrl }, 
                caption: formatearRespuesta(caption),
                gifPlayback: mediaUrl.endsWith('.gifv')
            });
        } else {
            await sock.sendMessage(chatId, { 
                image: { url: mediaUrl }, 
                caption: formatearRespuesta(caption)
            });
        }
    } catch (error) {
        console.error('[REDDIT ERROR]', error);
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⚠️ Error al buscar en Reddit. Probá con otro subreddit.') 
        });
    }
}

async function handlePinterest(sock, msg, senderJid, chatId, texto) {
    if (!botActivo && !esAdmin(senderJid, msg)) return;
    if (estaBaneado(senderJid) && !esAdmin(senderJid, msg)) return;

    const query = texto.split(' ').slice(1).join(' ').trim();
    if (!query) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('Formato: /pin [búsqueda]') 
        });
        return;
    }

    try {
        const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 10000
        });

        const $ = cheerio.load(data);
        const images = [];

        $('img').each((i, el) => {
            const src = $(el).attr('src') || $(el).attr('data-src');
            if (src && src.includes('pinimg.com') && !src.includes('avatar') && !src.includes('75x75')) {
                images.push(src);
            }
        });

        if (images.length === 0) {
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta('No encontré imágenes para esa búsqueda.') 
            });
            return;
        }

        const randomImg = images[Math.floor(Math.random() * images.length)];
        const imagenFinal = randomImg.replace(/\/\d+x\d+/, '/originals');

        await sock.sendMessage(chatId, { 
            image: { url: imagenFinal }, 
            caption: formatearRespuesta(`📌 Pinterest: ${query}`)
        });
    } catch (error) {
        console.error('[PINTEREST ERROR]', error);
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⚠️ Error al buscar en Pinterest.') 
        });
    }
}

async function handleLetras(sock, msg, senderJid, chatId, texto) {
    if (!botActivo && !esAdmin(senderJid, msg)) return;
    if (estaBaneado(senderJid) && !esAdmin(senderJid, msg)) return;

    const busqueda = texto.split(' ').slice(1).join(' ').trim();
    if (!busqueda.includes('-')) {
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('Formato: /letras [canción - artista]') 
        });
        return;
    }

    const [cancion, artista] = busqueda.split('-').map(s => s.trim());

    try {
        const { data } = await axios.get(
            `https://lrclib.net/api/search?q=${encodeURIComponent(cancion + ' ' + artista)}`,
            { timeout: 10000 }
        );

        if (!data || data.length === 0) {
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta('No encontré la letra de esa canción.') 
            });
            return;
        }

        const track = data.find(t => 
            t.trackName?.toLowerCase().includes(cancion.toLowerCase()) &&
            t.artistName?.toLowerCase().includes(artista.toLowerCase())
        ) || data[0];

        let letra = '';
        if (track.syncedLyrics) {
            letra = track.syncedLyrics
                .replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '')
                .replace(/<\d{2}:\d{2}\.\d{2,3}>/g, '')
                .trim();
        }
        if (!letra && track.plainLyrics) {
            letra = track.plainLyrics;
        }
        if (!letra) {
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta('No hay letra disponible para esta canción.') 
            });
            return;
        }

        const maxCaracteres = 4000;
        if (letra.length > maxCaracteres) {
            const partes = [];
            for (let i = 0; i < letra.length; i += maxCaracteres) {
                partes.push(letra.substring(i, i + maxCaracteres));
            }
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta(`🎵 ${track.trackName} - ${track.artistName}\n\n${partes[0]}`)
            });
            for (let i = 1; i < partes.length; i++) {
                await sock.sendMessage(chatId, { text: formatearRespuesta(partes[i]) });
            }
        } else {
            await sock.sendMessage(chatId, { 
                text: formatearRespuesta(`🎵 ${track.trackName} - ${track.artistName}\n\n${letra}`)
            });
        }
    } catch (error) {
        console.error('[LETRAS ERROR]', error);
        await sock.sendMessage(chatId, { 
            text: formatearRespuesta('⚠️ Error al buscar la letra.') 
        });
    }
}
// ==================== PROCESADOR DE MENSAJES ====================
async function procesarMensaje(sock, msg) {
    try {
        const chatId = msg.key.remoteJid;
        const rawSender = msg.key.participant || msg.key.remoteJid;
        const senderJid = limpiarJid(rawSender);

        const texto = getCaption(msg.message).trim();
        if (!texto || !texto.startsWith('/')) return;

        const esGrupo = chatId.endsWith('@g.us');

        // 🚨 CONTROL DE PRIVACIDAD: Únicamente responde en el grupo permitido.
        if (!esGrupo || chatId !== GRUPO_PERMITIDO) return;

        console.log(`[COMANDO DETECTADO] "${texto}" enviado por ${senderJid} en chat ${chatId}`);

        if (estaBaneado(senderJid) && !esAdmin(senderJid, msg)) {
            console.log(`[BLOQUEADO] ${senderJid} intentó usar comandos pero está baneado`);
            return;
        }

        const cacheKey = `${senderJid}-${texto}`;
        if (msgCache.has(cacheKey)) return;
        msgCache.set(cacheKey, true);

        const comandoRaw = texto.split(' ')[0];
        const comandoLower = comandoRaw.toLowerCase();

        const comandosAdmin = ['/status', '/on', '/off', '/+18on', '/+18off', '/modotrucadoon', '/modotrucadooff'];
        if (!botActivo && !esAdmin(senderJid, msg) && !comandosAdmin.includes(comandoLower)) return;

        switch(comandoLower) {
            case '/status':
                await handleStatus(sock, msg, chatId, senderJid);
                break;

            case '/on':
            case '/off':
            case '/+18on':
            case '/+18off':
            case '/modotrucadoon':
            case '/modotrucadooff':
                await handleToggle(sock, msg, chatId, senderJid, comandoLower.replace('/', ''));
                break;

            case '/ban':
                await handleBan(sock, msg, chatId, senderJid, 'ban');
                break;

            case '/unban':
                await handleBan(sock, msg, chatId, senderJid, 'unban');
                break;

            case '/ruleta':
                await handleRuleta(sock, msg, senderJid, chatId, texto);
                break;

            case '/google':
                await handleGoogle(sock, msg, senderJid, chatId, texto, false);
                break;

            case '/googlep':
                await handleGoogle(sock, msg, senderJid, chatId, texto, true);
                break;

            case '/reddit':
                if (comandoRaw === '/reddIt') {
                    await handleReddit(sock, msg, senderJid, chatId, texto, true);
                } else {
                    await handleReddit(sock, msg, senderJid, chatId, texto, false);
                }
                break;

            case '/pin':
                await handlePinterest(sock, msg, senderJid, chatId, texto);
                break;

            case '/letras':
                await handleLetras(sock, msg, senderJid, chatId, texto);
                break;
        }
    } catch (error) {
        console.error('[PROCESAR ERROR]', error);
    }
}

// ==================== CONEXIÓN BAILEYS + MONGODB ====================
async function iniciarBot() {
    try {
        console.log("🗄️ Conectando a la base de datos MongoDB Atlas...");
        const mongoClient = new MongoClient(process.env.MONGO_URI);
        await mongoClient.connect();
        const db = mongoClient.db("whatsapp_bot");
        const collection = db.collection("session");

        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            logger: pino({ level: 'fatal' }),
            markOnlineOnConnect: true,
            defaultQueryTimeoutMs: 60000,
            generateHighQualityLinkPreview: true
        });

        if (!sock.authState.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true;
            setTimeout(async () => {
                try {
                    console.log('🔐 Solicitando código de emparejamiento...');
                    const codigo = await sock.requestPairingCode(HOST_ADMIN.split('@')[0]);
                    console.log('═══════════════════════════════════════════');
                    console.log('📱 CÓDIGO DE VINCULACIÓN:', codigo);
                    console.log('═══════════════════════════════════════════');
                } catch (err) {
                    console.error('[CÓDIGO ERROR]', err.message);
                    pairingCodeRequested = false;
                }
            }, 5000); 
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log('[CONEXIÓN] ✅ Bot conectado exitosamente a WhatsApp');
                pairingCodeRequested = false;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
                console.log(`[CONEXIÓN] Cerrada. Razón/Código: ${statusCode}. Procesando reconexión...`);

                pairingCodeRequested = false;

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('[CONEXIÓN] Sesión eliminada de WhatsApp. Limpiando base de datos para empezar de cero...');
                    try {
                        await collection.deleteMany({}); 
                    } catch (err) {
                        console.error('[ERROR LIMPIEZA]', err.message);
                    }
                    setTimeout(iniciarBot, 5000);
                } else {
                    console.log('[CONEXIÓN] Desconexión temporal o rechazo de servidor. Reintentando en 8 segundos...');
                    setTimeout(iniciarBot, 8000);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message) return;

            const textoPrevia = getCaption(msg.message).trim();
            if (msg.key.fromMe && textoPrevia.startsWith('[¡+!]')) return;

            procesarMensaje(sock, msg).catch(err => {
                console.error('[ERROR MENSAJE]', err);
            });
        });

        return sock;
    } catch (error) {
        console.error('[ERROR FATAL]', error);
        setTimeout(iniciarBot, 10000);
    }
}

// Manejo de errores global
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});

// Iniciar todo
console.log('🚀 Iniciando bot...');
iniciarBot();
