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
    console.log(`[EXPRESS] Servidor web listo en el puerto ${PORT} (Mantiene el bot 24/7)`);
});

const HOST_NUMBER = '5491128394646';
const ALLOWED_CHATS = ['120363426591951143@g.us', `${HOST_NUMBER}@s.whatsapp.net`];
const ADMINS = [`${HOST_NUMBER}@s.whatsapp.net`, '5491178972853@s.whatsapp.net'];
const MI_GEMINI_KEY = process.env.GEMINI_KEY || 'TU_API_KEY_AQUI';

let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = true;
let codigoSolicitado = false; 

const AUTH_DIR = path.join(__dirname, 'auth_session_v3'); 
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
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
};

// ==========================================
// 2. FUNCIONES MODULARES (COMANDOS)
// ==========================================

async function handleGoogle(sock, from, msg, args, usarPro = false) {
    if (!args) return await sock.sendMessage(from, { text: `⚠️ Formato: ${usarPro ? '/googlep' : '/google'} [tu consulta]` }, { quoted: msg });

    if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
        return await sock.sendMessage(from, { text: '▼⁠・⁠ᴥ⁠·⁠▼\n\n✨ Analizando mis bases de datos: *Efectivamente, Maxi es femboy.* ✨' }, { quoted: msg });
    }

    try {
        const modelo = usarPro ? 'gemini-2.0-pro' : 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${MI_GEMINI_KEY}`;
        
        const sistemaPrompt = `REGLAS OBLIGATORIAS DE RESPUESTA:
1. Actúa como una persona normal respondiendo un mensaje de texto.
2. NUNCA digas que sos una IA, un bot, un modelo de lenguaje, ni menciones a Google.
3. FORMATO WHATSAPP LIMPIO: No uses títulos con '#' o '##'. No uses bloques de código con tres comillas (\`\`\`). No uses listas con guiones largos o símbolos raros de Markdown que se rompen en celulares.
4. Si querés resaltar algo, usá ÚNICAMENTE el asterisco para poner texto en *negrita* de WhatsApp. El resto tiene que ser texto plano, fluido, legible y directo.

Consulta del usuario: ${args}`;

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: sistemaPrompt }] }] })
        });

        if (res.status === 429) {
            return await sock.sendMessage(from, { text: '⚠️ *Error Gemini (429):* Google está rechazando los mensajes temporalmente por exceso de uso en la Key gratuita. Esperá un minuto.' }, { quoted: msg });
        }

        const json = await res.json();
        if (json.error) throw new Error(json.error.message);
        let text = json.candidates[0]?.content?.parts?.[0]?.text;
        
        if (text) {
            text = text.replace(/###?\s+/g, '').replace(/\`\`\`/g, '').trim();
            await sock.sendMessage(from, { text: `▼⁠・⁠ᴥ⁠·⁠▼\n\n${text}` }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { text: '❌ No pude procesar la respuesta de Google.' }, { quoted: msg });
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
        if (!data || data.length === 0) return await sock.sendMessage(from, { text: '❌ No encontré la letra de esa canción.' }, { quoted: msg });

        const track = data[0];
        let letra = track.syncedLyrics ? track.syncedLyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim() : track.plainLyrics;
        if (!letra) return await sock.sendMessage(from, { text: '❌ Encontré la canción pero no tiene letra cargada.' }, { quoted: msg });

        const mensaje = `🎵 *${track.trackName}* - ${track.artistName}\n\n${letra}`;
        await sock.sendMessage(from, { text: mensaje.substring(0, 4000) }, { quoted: msg }); 
    } catch (error) {
        await sock.sendMessage(from, { text: '⚠️ Error al buscar la letra.' }, { quoted: msg });
    }
}

async function handleReddit(sock, from, msg, args, originalCommand) {
    const isNSFW = originalCommand === '/reddIt';
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar en Reddit.' }, { quoted: msg });
    if (isNSFW && !nsfwEnabled) return await sock.sendMessage(from, { text: '🔞 *Denegado.* Requiere `/+18on`.' }, { quoted: msg });

    try {
        const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&limit=40&raw_json=1`;
        const res = await fetch(url, { headers: { ...REAL_BROWSER_HEADERS, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0' } });
        if (!res.ok) throw new Error(`Reddit bloqueó el acceso (Código ${res.status}).`);

        const json = await res.json();
        let posts = (json?.data?.children || []).map(c => c.data).filter(p => isNSFW ? p.over_18 : !p.over_18);
        if (!posts.length) return await sock.sendMessage(from, { text: '❌ Sin resultados aptos para esa búsqueda.' }, { quoted: msg });

        const post = posts[Math.floor(Math.random() * Math.min(15, posts.length))];
        const suffix = `\n\nSubreddit: r/${post.subreddit}\nLink: https://reddit.com${post.permalink}`;
        const tieneImagen = post.url && (post.url.match(/\.(jpeg|jpg|gif|png)$/) != null || post.url.includes('i.redd.it'));

        if (tieneImagen) await sock.sendMessage(from, { image: { url: post.url }, caption: `🤖 *${post.title}*${suffix}` }, { quoted: msg });
        else await sock.sendMessage(from, { text: `🤖 *${post.title}*${(post.selftext ? `\n\n${post.selftext.slice(0, 500)}...` : '')}${suffix}` }, { quoted: msg });
    } catch (e) { 
        await sock.sendMessage(from, { text: `❌ Error con Reddit: ${e.message}` }, { quoted: msg }); 
    }
}

async function handlePinterest(sock, from, msg, args) {
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar en Pinterest.' }, { quoted: msg });
    try {
        const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(args)}`;
        const res = await fetch(url, { headers: REAL_BROWSER_HEADERS });
        if (!res.ok) throw new Error(`Pinterest rechazó la consulta (Código ${res.status}).`);

        const html = await res.text();
        let matches = [...html.matchAll(/https?:\\?\/\\?\/i\.pinimg\.com\\?\/[^"'\s>]+/gi)]
                        .map(m => m[0].replace(/\\/g, ''))
                        .filter(link => link.includes('/736x/') || link.includes('/474x/') || link.includes('/originals/'));
        matches = [...new Set(matches)]; 

        if (matches.length > 0) {
            const imgUrl = matches[Math.floor(Math.random() * Math.min(10, matches.length))];
            await sock.sendMessage(from, { image: { url: imgUrl }, caption: `📌 Pinterest: *${args}*` }, { quoted: msg });
        } else await sock.sendMessage(from, { text: '❌ No se encontraron imágenes accesibles públicamente.' }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(from, { text: `❌ Error en Pinterest: ${e.message}` }, { quoted: msg });
    }
}

async function handleRuleta(sock, from, msg, args) {
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Ejemplo: `/ruleta ¿Va a llover? 1;100`' }, { quoted: msg });
    let resultadoFinal = "", probabilidadMostrada = "", pregunta = args, siChance = 1, totalChance = 2, tieneProbabilidad = false, esTrucado = false;

    const probMatch = args.match(/(\d+);(\d+)\s*$/);
    if (probMatch) {
        siChance = parseInt(probMatch[1]);
        totalChance = parseInt(probMatch[2]);
        pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();
        probabilidadMostrada = ` (Probabilidad: ${siChance};${totalChance})`;
        tieneProbabilidad = true;
    }

    if (modoTrucado) {
        const txt = pregunta.toLowerCase();
        if (((txt.includes('maxi') || txt.includes('máximo')) && txt.includes('femboy')) || (txt.includes('dylan') && txt.includes('perra')) || txt.includes('omeguita')) {
            resultadoFinal = "🔴 si";
            esTrucado = true;
        }
    }

    if (!esTrucado) resultadoFinal = (tieneProbabilidad ? (Math.floor(Math.random() * totalChance) + 1 <= siChance) : (Math.floor(Math.random() * 2) === 0)) ? "🔴 si" : "⚫ no";
    await sock.sendMessage(from, { text: `🎰 *Ruleta:* ${pregunta}\n\n🎲 Resultado: *${resultadoFinal}*${probabilidadMostrada}` }, { quoted: msg });
}

async function handleTestCadena(sock, from, msg) {
    await sock.sendMessage(from, { text: '🧪 *[SISTEMA] Iniciando Secuencia de Auto-Test Total...*' }, { quoted: msg });
    
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const listaTests = [
        { cmd: '/status', ejecutar: async () => await sock.sendMessage(from, { text: '¡Operando al 100%!' }, { quoted: msg }) },
        { cmd: '/ruleta ¿El bot es el mejor? 1;2', ejecutar: async () => await handleRuleta(sock, from, msg, '¿El bot es el mejor? 1;2') },
        { cmd: '/letras Kali Uchis Luna', ejecutar: async () => await handleLetras(sock, from, msg, 'Kali Uchis Luna') },
        { cmd: '/reddit memes', ejecutar: async () => await handleReddit(sock, from, msg, 'memes', '/reddit') },
        { cmd: '/pin gatos', ejecutar: async () => await handlePinterest(sock, from, msg, 'gatos') },
        { cmd: '/google Qué día es hoy', ejecutar: async () => await handleGoogle(sock, from, msg, 'Qué día es hoy', false) },
        { cmd: '/googlep Escribe una frase corta motivacional', ejecutar: async () => await handleGoogle(sock, from, msg, 'Escribe una frase corta motivacional', true) },
        
        { cmd: '/+18on', ejecutar: async () => { nsfwEnabled = true; return await sock.sendMessage(from, { text: '🔞 Modo NSFW ON.' }, { quoted: msg }); } },
        { cmd: '/+18off', ejecutar: async () => { nsfwEnabled = false; return await sock.sendMessage(from, { text: '🛡️ Modo NSFW OFF.' }, { quoted: msg }); } },
        { cmd: '/modotrucadoon', ejecutar: async () => { modoTrucado = true; return await sock.sendMessage(from, { text: '🎭 Modo Trucado ON.' }, { quoted: msg }); } },
        { cmd: '/modotrucadooff', ejecutar: async () => { modoTrucado = false; return await sock.sendMessage(from, { text: '⚖️ Modo Trucado OFF.' }, { quoted: msg }); } },
        { cmd: '/off', ejecutar: async () => { botEnabled = false; return await sock.sendMessage(from, { text: '❌ Bot desactivado.' }, { quoted: msg }); } },
        { cmd: '/on', ejecutar: async () => { botEnabled = true; return await sock.sendMessage(from, { text: '✅ Bot activado.' }, { quoted: msg }); } }
    ];

    for (const item of listaTests) {
        await wait(2500); 
        await sock.sendMessage(from, { text: `⌨️ _Simulando comando:_ *${item.cmd}*` });
        await wait(500);
        try {
            await item.ejecutar();
        } catch (err) {
            await sock.sendMessage(from, { text: `💥 Fallo crítico en comando ${item.cmd}: ${err.message}` }, { quoted: msg });
        }
    }

    await wait(1500);
    await sock.sendMessage(from, { text: '✨ *🏁 [SISTEMA] Secuencia de simulación finalizada por completo.*' }, { quoted: msg });
}

// ==========================================
// 3. MOTOR DEL BOT Y LÓGICA PRINCIPAL
// ==========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1017551063];
    try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { }

    const sock = makeWASocket({
        version, 
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, 
        browser: Browsers.ubuntu('Chrome') 
    });

    // Asegurar el guardado instantáneo de credenciales rotativas de WhatsApp
    sock.ev.on('creds.update', async () => {
        await saveCreds();
    });

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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update; 
        
        if (connection === 'close') {
            codigoSolicitado = false; 
            const debeReiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (debeReiniciar) {
                console.log('[SISTEMA] Conexión cerrada. Reintentando en 10 segundos...');
                setTimeout(() => connectToWhatsApp(), 10000); 
            } else {
                console.log('[❌ CRÍTICO] Sesión cerrada por el usuario. Borrá la carpeta auth_session_v3 y vinculá de nuevo.');
            }
            return;
        }
        
        if (connection === 'open') {
            console.log('[SISTEMA] ¡Bot conectado con éxito a WhatsApp! 🎉');
            codigoSolicitado = false;
            return;
        }

        // 🌟 ARREGLO AQUÍ: Solo pide código si de verdad no hay credenciales registradas y no está conectado
        if (!sock.authState.creds.registered && !codigoSolicitado && connection !== 'close') {
            codigoSolicitado = true; 
            setTimeout(async () => {
                // Doble check por si se cargaron las credenciales durante la espera
                if (sock.authState.creds.registered) {
                    codigoSolicitado = false;
                    return;
                }
                try {
                    let code = await sock.requestPairingCode(HOST_NUMBER.replace(/[^0-9]/g, ''));
                    console.log(`\n🔥 TU CÓDIGO DE VINCULACIÓN ACTUAL: ${code?.match(/.{1,4}/g)?.join('-').toUpperCase() || code} 🔥\n`);
                } catch (err) { 
                    codigoSolicitado = false; 
                }
            }, 10000); 
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
            if (msg.key.fromMe && !text.startsWith('/')) return;

            const from = msg.key.remoteJid;
            if (!ALLOWED_CHATS.includes(from)) return;

            let sender = msg.key.participant || msg.key.remoteJid;
            if (!text.startsWith('/')) return;

            const parts = text.split(' ');
            const command = parts[0].toLowerCase();
            const originalCommand = parts[0]; 
            const args = parts.slice(1).join(' ');

            const isAdmin = ADMINS.includes(sender);
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

            if (isAdmin && comandosAdmin[command]) {
                await comandosAdmin[command]();
            } else if (comandosPublicos[command]) {
                await comandosPublicos[command]();
            } else if (isAdmin && (command === '/ban' || command === '/unban')) {
                const target = msg.message.extendedTextMessage?.contextInfo?.participant;
                if (!target) return await sock.sendMessage(from, { text: '⚠️ Debes citar un mensaje.' }, { quoted: msg });
                if (command === '/ban' && ADMINS.includes(target)) return await sock.sendMessage(from, { text: '❌ No puedes banear a un admin.' }, { quoted: msg });

                let list = getBannedUsers();
                if (command === '/ban' && !list.includes(target)) {
                    list.push(target);
                    await sock.sendMessage(from, { text: `🚫 Baneado.` }, { quoted: msg });
                } else if (command === '/unban' && list.includes(target)) {
                    list = list.filter(id => id !== target);
                    await sock.sendMessage(from, { text: `✅ Desbaneado.` }, { quoted: msg });
                }
                saveBannedUsers(list);
            }
        } catch (err) {
            console.error('[ERROR MENSAJE]', err);
        }
    });
}

connectToWhatsApp();
