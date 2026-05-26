const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay,
    fetchLatestBaileysVersion // 🔥 NUEVO: Necesario para evitar el error 405
} = require('@whiskeysockets/baileys');

// ==========================================
// 1. CONFIGURACIÓN DEL SERVIDOR EXPRESS (UptimeRobot)
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Bot de WhatsApp Operando de manera Correcta.');
});

app.listen(PORT, () => {
    console.log(`[EXPRESS] Servidor listo y escuchando en el puerto ${PORT}`);
});

// ==========================================
// 2. VARIABLES ESTÁTICAS Y CONTROL DE ESTADO
// ==========================================
const ALLOWED_GROUP = '120363426591951143@g.us';
const ADMINS = ['5491128394646@s.whatsapp.net', '5491178972853@s.whatsapp.net'];
const HOST_NUMBER = '5491128394646';

let botEnabled = true;
let nsfwEnabled = false;

// Directorio y base de datos para usuarios baneados
const AUTH_DIR = path.join(__dirname, 'auth_session');
const BANNED_FILE = path.join(AUTH_DIR, 'baneados.json');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function getBannedUsers() {
    if (!fs.existsSync(BANNED_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(BANNED_FILE, 'utf-8'));
    } catch (e) {
        return [];
    }
}

function saveBannedUsers(list) {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(list, null, 2));
}

// ==========================================
// 3. FUNCIÓN PRINCIPAL DE CONEXIÓN (BAILEYS)
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // 🔥 CORRECCIÓN: Buscamos la última versión web para que WhatsApp no nos tire un 405
    let version = [2, 3000, 1017551063]; // Versión de respaldo
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
        console.log(`[SISTEMA] Conectando con WhatsApp Web v${version.join('.')}`);
    } catch (e) {
        console.log(`[ALERTA] No se pudo obtener la última versión, usando respaldo.`);
    }

    const sock = makeWASocket({
        version, // 🔥 IMPORTANTE: Asignamos la versión actualizada
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, // No usamos QR, usamos Pairing Code
        browser: ["Ubuntu", "Chrome", "20.0.04"] // 🔥 IMPORTANTE: Camuflaje para Render
    });

    // Mecanismo de Vinculación por Código
    if (!sock.authState.creds.registered) {
        console.log(`[VINCULACIÓN] Detectada falta de sesión. Generando código de emparejamiento...`);
        setTimeout(async () => {
            try {
                // Verificamos que el socket siga abierto antes de pedir el código
                let code = await sock.requestPairingCode(HOST_NUMBER);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\n====================================`);
                console.log(`CÓDIGO DE VINCULACIÓN EN RENDER: ${code}`);
                console.log(`====================================\n`);
            } catch (err) {
                console.error('[ERROR] No se pudo generar el código de vinculación:', err.message);
            }
        }, 4000); // Subido a 4 segundos para dar estabilidad a la conexión inicial
    }

    // Manejo de eventos de conexión
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[CONEXIÓN] Cerrada. Razón/Status Code: ${reason}`);

            // Evaluar freno anti-spam por falta de sesión o expulsión
            if (reason === DisconnectReason.loggedOut || !sock.authState.creds.registered) {
                console.log(`[ANTI-SPAM] Desconexión crítica (Falta de sesión/Expulsión). Reintentando en 5 minutos (300000ms)...`);
                setTimeout(connectToWhatsApp, 300000);
            } else {
                console.log(`[RECONEXIÓN] Intento de reconexión estándar en 10 segundos...`);
                setTimeout(connectToWhatsApp, 10000);
            }
        } else if (connection === 'open') {
            console.log('[CONEXIÓN] ¡Bot conectado exitosamente a WhatsApp!');
        }
    });

    // Guardado automático de credenciales actualizadas
    sock.ev.on('creds.update', saveCreds);

    // Escucha e interpretación de mensajes incoming
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            
            // Filtro radical: Solo responder en el grupo permitido
            if (from !== ALLOWED_GROUP) return;

            // Extraer el remitente (remitente en grupo)
            const sender = msg.key.participant || msg.key.remoteJID;

            // Extraer texto del mensaje de múltiples estructuras posibles
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || '';

            if (!text.startsWith('/')) return;

            const parts = text.split(' ');
            const command = parts[0].toLowerCase();
            const args = parts.slice(1).join(' ');

            const isAdmin = ADMINS.includes(sender);
            const bannedList = getBannedUsers();
            const isBanned = bannedList.includes(sender);

            // Si el usuario está baneado y no es Admin, el bot lo ignora de forma silenciosa
            if (isBanned && !isAdmin) return;

            // ==========================================
            // 4. SECCIÓN DE COMANDOS DE ADMINISTRADOR
            // ==========================================
            if (isAdmin) {
                if (command === '/status') {
                    await sock.sendMessage(from, { text: '¡Estoy vivo y operando perfectamente!' }, { quoted: msg });
                    return;
                }

                if (command === '/on') {
                    botEnabled = true;
                    await sock.sendMessage(from, { text: '✅ El bot ha sido activado para el público.' }, { quoted: msg });
                    return;
                }

                if (command === '/off') {
                    botEnabled = false;
                    await sock.sendMessage(from, { text: '❌ El bot ha sido desactivado. Solo los admins pueden usarlo.' }, { quoted: msg });
                    return;
                }

                if (command === '/+18on') {
                    nsfwEnabled = true;
                    await sock.sendMessage(from, { text: '🔞 Modo NSFW Activado. Se permite contenido explícito en las búsquedas.' }, { quoted: msg });
                    return;
                }

                if (command === '/+18off') {
                    nsfwEnabled = false;
                    await sock.sendMessage(from, { text: '🛡️ Modo NSFW Desactivado. SafeSearch estricto habilitado.' }, { quoted: msg });
                    return;
                }

                if (command === '/ban') {
                    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (!quotedParticipant) {
                        await sock.sendMessage(from, { text: '⚠️ Debes responder al mensaje de alguien para banearlo.' }, { quoted: msg });
                        return;
                    }
                    if (ADMINS.includes(quotedParticipant)) {
                        await sock.sendMessage(from, { text: '❌ No puedes banear a un administrador.' }, { quoted: msg });
                        return;
                    }
                    if (!bannedList.includes(quotedParticipant)) {
                        bannedList.push(quotedParticipant);
                        saveBannedUsers(bannedList);
                        await sock.sendMessage(from, { text: `🚫 El usuario @${quotedParticipant.split('@')[0]} ha sido baneado.`, mentions: [quotedParticipant] }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: 'Este usuario ya se encuentra baneado.' }, { quoted: msg });
                    }
                    return;
                }

                if (command === '/unban') {
                    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if (!quotedParticipant) {
                        await sock.sendMessage(from, { text: '⚠️ Debes responder al mensaje de alguien para desbanearlo.' }, { quoted: msg });
                        return;
                    }
                    if (bannedList.includes(quotedParticipant)) {
                        const updatedList = bannedList.filter(id => id !== quotedParticipant);
                        saveBannedUsers(updatedList);
                        await sock.sendMessage(from, { text: `✅ El usuario @${quotedParticipant.split('@')[0]} ha sido desbaneado.`, mentions: [quotedParticipant] }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: 'Este usuario no estaba en la lista de baneados.' }, { quoted: msg });
                    }
                    return;
                }
            }

            // Si el bot está apagado para los usuarios normales, bloqueamos la ejecución aquí
            if (!botEnabled && !isAdmin) return;

            // ==========================================
            // 5. SECCIÓN DE COMANDOS PÚBLICOS
            // ==========================================
            if (command === '/google') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Especificá qué querés buscar. Ejemplo: `/google Nikola Tesla`' }, { quoted: msg });
                    return;
                }

                // 🌟 HUEVO DE PASCUA: Cualquier búsqueda relacionada con Maxi tira esto
                const checkMaxi = args.toLowerCase();
                if (checkMaxi.includes('maxi') || checkMaxi.includes('máximo')) {
                    await sock.sendMessage(from, { text: '🔍 *Resultado de Google:*\n\n✨ Basado en datos científicos e irrefutables: *Sí, Maxi es femboy.* ✨' }, { quoted: msg });
                    return;
                }

                try {
                    const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(args)}`);
                    if (!res.ok) throw new Error('No se encontró información en Wikipedia.');
                    const data = await res.json();
                    
                    const responseText = `📚 *${data.title}*\n\n${data.extract}`;
                    await sock.sendMessage(from, { text: responseText }, { quoted: msg });
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ No se encontraron resultados o hubo un error con Wikipedia.' }, { quoted: msg });
                }
                return;
            }

            if (command === '/reddit') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Especificá qué querés buscar en Reddit.' }, { quoted: msg });
                    return;
                }
                try {
                    const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(args)}`);
                    const json = await res.json();
                    const posts = json?.data?.children || [];

                    let allowedPosts = posts;
                    // Si el filtro NSFW está apagado, limpiamos las publicaciones marcadas como over_18
                    if (!nsfwEnabled) {
                        allowedPosts = posts.filter(p => !p.data.over_18);
                    }

                    if (allowedPosts.length === 0) {
                        await sock.sendMessage(from, { text: '❌ No se encontraron posts (o el contenido fue filtrado por NSFW).' }, { quoted: msg });
                        return;
                    }

                    // Intentamos localizar un post que contenga una URL de imagen directa
                    const imagePost = allowedPosts.find(p => p.data.url && (p.data.url.endsWith('.jpg') || p.data.url.endsWith('.png') || p.data.url.endsWith('.jpeg') || p.data.url.endsWith('.gif')));

                    if (imagePost) {
                        await sock.sendMessage(from, { 
                            image: { url: imagePost.data.url }, 
                            caption: `🤖 *${imagePost.data.title}*\n\nSubreddit: r/${imagePost.data.subreddit}\nLink: https://reddit.com${imagePost.data.permalink}` 
                        }, { quoted: msg });
                    } else {
                        // En su defecto, mandamos la primera coincidencia puramente textual
                        const textPost = allowedPosts[0].data;
                        const bodyContent = textPost.selftext ? `\n\n${textPost.selftext.slice(0, 500)}...` : '';
                        await sock.sendMessage(from, { 
                            text: `🤖 *${textPost.title}*\nSubreddit: r/${textPost.subreddit}${bodyContent}\n\nLink: ${textPost.url}` 
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ Error al conectar con la API de Reddit.' }, { quoted: msg });
                }
                return;
            }

            if (command === '/pin') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Especificá la imagen que buscás en Bing.' }, { quoted: msg });
                    return;
                }
                try {
                    const adltParam = nsfwEnabled ? 'off' : 'strict';
                    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(args)}&adlt=${adltParam}`;
                    
                    const response = await fetch(bingUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
                        }
                    });
                    const html = await response.text();
                    
                    // Regex específico para extraer las URLs de origen directo (murl) del HTML de Bing Images
                    const regex = /murl&quot;:&quot;(http.*?)&quot;/g;
                    let matches = [];
                    let match;
                    while ((match = regex.exec(html)) !== null) {
                        matches.push(match[1]);
                    }

                    if (matches.length > 0) {
                        // Enviamos la primera imagen válida obtenida del scraping
                        await sock.sendMessage(from, { 
                            image: { url: matches[0] }, 
                            caption: `🔍 *Resultado de Bing para:* ${args}` 
                        }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No se encontraron imágenes para esa búsqueda.' }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ Error al realizar el scraping en el motor de Bing.' }, { quoted: msg });
                }
                return;
            }

            if (command === '/letras') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Especificá qué canción querés buscar. Ejemplo: `/letras Cuarteto de Nos Roberto`' }, { quoted: msg });
                    return;
                }
                try {
                    const res = await fetch(`https://lyrist.vercel.app/api/${encodeURIComponent(args)}`);
                    const data = await res.json();
                    if (data.lyrics) {
                        const responseText = `🎵 *${data.title}* - _${data.artist}_\n\n${data.lyrics}`;
                        await sock.sendMessage(from, { text: responseText }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No encontré la letra de esa canción.' }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ Error de conexión al buscar la letra.' }, { quoted: msg });
                }
                return;
            }

            if (command === '/ruleta') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Hacé una pregunta. Podés agregar la probabilidad al final (ej: `/ruleta apruebo? 1;10`).' }, { quoted: msg });
                    return;
                }

                // Intentamos capturar el formato X;Y al final del mensaje
                const match = args.match(/(\d+);(\d+)\s*$/);
                let siChance = 1;
                let totalChance = 2; // Por defecto es 50/50 (1 de 2)
                let pregunta = args;

                if (match) {
                    siChance = parseInt(match[1]);
                    totalChance = parseInt(match[2]);
                    pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();

                    if (siChance > totalChance || siChance <= 0 || totalChance <= 0) {
                        await sock.sendMessage(from, { text: '⚠️ Probabilidades inválidas. El formato correcto es `1;10` (el primer número debe ser menor o igual al segundo).' }, { quoted: msg });
                        return;
                    }
                }

                const checkMaxi = pregunta.toLowerCase();
                let resultado = '';

                // 🌟 HUEVO DE PASCUA: Hackea la matemática de la ruleta
                if (checkMaxi.includes('maxi') || checkMaxi.includes('máximo')) {
                    // Ignora completamente el azar y decreta que siempre sale SÍ
                    resultado = '🔴 SÍ';
                } else {
                    // Cálculo aleatorio normal
                    const random = Math.floor(Math.random() * totalChance) + 1;
                    resultado = random <= siChance ? '🔴 SÍ' : '⚫ NO';
                }

                await sock.sendMessage(from, { text: `🎰 *Ruleta:* ${pregunta}\n\n🎲 Resultado: *${resultado}* (Probabilidad: ${siChance} de ${totalChance})` }, { quoted: msg });
                return;
            }

        } catch (e) {
            console.error('[MANEJADOR MENSAJES] Error interno:', e);
        }
    });
}

// Iniciar la ejecución del bot de forma segura
connectToWhatsApp();
