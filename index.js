const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion
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
const HOST_NUMBER = '5491128394646';

let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = true;

const AUTH_DIR = path.join(__dirname, 'auth_session');
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
// 2. MOTOR DEL BOT Y LÓGICA PRINCIPAL
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
        browser: ["Ubuntu", "Chrome", "20.0.04"] 
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

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(HOST_NUMBER);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\nCÓDIGO DE VINCULACIÓN: ${code}\n`);
            } catch (err) {}
        }, 4000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut || !sock.authState.creds.registered) {
                setTimeout(connectToWhatsApp, 300000);
            } else {
                setTimeout(connectToWhatsApp, 10000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // 3. INTERPRETACIÓN DE MENSAJES
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            if (from !== ALLOWED_GROUP) return;

            let sender = msg.key.participant || msg.key.remoteJid;
            if (msg.key.fromMe && sock.user) {
                sender = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            }

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || '';

            if (!text.startsWith('/')) return;

            const parts = text.split(' ');
            const command = parts[0].toLowerCase();
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

            // --- COMANDOS PÚBLICOS ---

            // 🎲 RULETA (Corregida con Randomizer y Probabilidades)
            if (command === '/ruleta') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Escribí opciones, una pregunta o una probabilidad (ej: 1;100).' }, { quoted: msg });
                    return;
                }
                
                let result = "";
                let probText = "";
                
                // 1. Detectar si el usuario mandó una probabilidad (Ej: 1;100 o 1/100)
                const probMatch = args.match(/^(\d+)[;/](\d+)$/);
                
                if (probMatch) {
                    const probYes = parseInt(probMatch[1]);
                    const total = parseInt(probMatch[2]);
                    
                    if (probYes >= 0 && total > 0 && probYes <= total) {
                        const rand = Math.floor(Math.random() * total) + 1;
                        if (rand <= probYes) {
                            result = "🟥 Sí";
                        } else {
                            result = "⬛ No";
                        }
                        probText = ` (${probYes} en ${total})`;
                    } else {
                        await sock.sendMessage(from, { text: '⚠️ Formato inválido. Usá algo como 1;100.' }, { quoted: msg });
                        return;
                    }
                } else {
                    // 2. Lógica aleatoria normal (Preguntas u opciones con comas)
                    let opciones = args.split(',').map(op => op.trim()).filter(op => op !== '');
                    if (opciones.length < 2) {
                        opciones = ['🟥 Sí', '⬛ No', 'Tal vez', 'Definitivamente no', 'Claro que sí'];
                    }
                    result = opciones[Math.floor(Math.random() * opciones.length)];
                    
                    // Colorear respuestas si cayeron en el Sí o No genérico de la ruleta
                    if (/^(si|sí)$/i.test(result)) result = '🟥 Sí';
                    if (/^no$/i.test(result)) result = '⬛ No';
                }

                // 3. Modo Trucado (Solo se aplica y pisa el resultado si es una de las preguntas clave)
                if (modoTrucado) {
                    const checkText = args.toLowerCase();
                    const trampaMaxi = (checkText.includes('maxi') || checkText.includes('máximo')) && checkText.includes('femboy');
                    const trampaDylan = checkText.includes('dylan') && checkText.includes('perra');
                    const trampaBot = (checkText.includes('bot') || checkText.includes('ia') || checkText.includes('vos')) && checkText.includes('omeguita');

                    if (trampaMaxi || trampaDylan || trampaBot) {
                        result = "🟥 ¡Sí, absolutamente! ✨";
                        probText = ""; // Oculta los números si está trucado
                    }
                }

                await sock.sendMessage(from, { text: `🎲 *Girando la ruleta...*\n\n🎯 Resultado: ${result}${probText}` }, { quoted: msg });
                return;
            }

            // 🧠 GOOGLE (Gemini - Con API restaurada y capturador de errores)
            if (command === '/google') {
                if (!args) { await sock.sendMessage(from, { text: '⚠️ Preguntame lo que quieras.' }, { quoted: msg }); return; }

                if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
                    await sock.sendMessage(from, { text: '🤖 *IA:*\n\n✨ Analizando mis bases de datos: *Sí, Maxi es femboy.* ✨' }, { quoted: msg });
                    return;
                }

                try {
                    // Tu API KEY exacta devuelta al código
                    const geminiApiKey = 'AIzaSyAxeWKyd8nR6GFrhHg7XBmq2cWwCPVyADI'; 
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
                    
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: args }] }] })
                    });
                    
                    const json = await res.json();
                    
                    if (json.error) {
                        await sock.sendMessage(from, { text: `❌ Google rechazó la conexión.\nRazón: ${json.error.message}` }, { quoted: msg });
                        return;
                    }

                    if (json.candidates) {
                        await sock.sendMessage(from, { text: `🧠 *IA:*\n\n${json.candidates[0].content.parts[0].text}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No pude procesar tu pregunta.' }, { quoted: msg });
                    }
                } catch (e) { 
                    await sock.sendMessage(from, { text: `❌ Fallo en fetch: ${e.message}` }, { quoted: msg }); 
                }
                return;
            }

            // 👽 REDDIT (Con User-Agent robusto)
            if (command === '/reddit') {
                if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar.' }, { quoted: msg }); return; }
                const isNsfwCommand = text.startsWith('/reddIt');

                if (isNsfwCommand && !nsfwEnabled) {
                    await sock.sendMessage(from, { text: '🔞 *Denegado.* Requiere `/+18on`.' }, { quoted: msg }); return;
                }

                try {
                    const url = isNsfwCommand 
                        ? `https://www.reddit.com/search.json?q=${encodeURIComponent(args + ' nsfw')}&include_over_18=on&sort=top&limit=25`
                        : `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&sort=hot&limit=25`;

                    const res = await fetch(url, { 
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Accept': 'application/json, text/plain, */*',
                            'Accept-Language': 'es-ES,es;q=0.9'
                        } 
                    });
                    
                    if (!res.ok) {
                        await sock.sendMessage(from, { text: `❌ Error de servidor Reddit (Código ${res.status}). Intentá buscar en inglés o probá en unos minutos.` }, { quoted: msg }); return;
                    }

                    const json = await res.json();
                    let posts = json?.data?.children || [];

                    posts = isNsfwCommand 
                        ? posts.filter(p => p.data.over_18 && p.data.selftext?.length > 150)
                        : posts.filter(p => !p.data.over_18);

                    if (!posts.length) { await sock.sendMessage(from, { text: '❌ Sin resultados para esa búsqueda.' }, { quoted: msg }); return; }

                    const post = posts[Math.floor(Math.random() * Math.min(5, posts.length))].data;
                    const suffix = `\nSubreddit: r/${post.subreddit}\nLink: https://reddit.com${post.permalink}`;

                    if (post.url && !post.is_self && (post.url.endsWith('.jpg') || post.url.endsWith('.png'))) {
                        await sock.sendMessage(from, { image: { url: post.url }, caption: `🤖 *${post.title}*${suffix}` }, { quoted: msg });
                    } else {
                        const body = post.selftext ? `\n\n${post.selftext.slice(0, 800)}...` : '';
                        await sock.sendMessage(from, { text: `🤖 *${post.title}*${body}${suffix}` }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(from, { text: `❌ Error al conectar con Reddit: ${e.message}` }, { quoted: msg }); }
                return;
            }

            // 📌 PIN (Bing re-estructurado)
            if (command === '/pin') {
                if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá la imagen.' }, { quoted: msg }); return; }
                try {
                    const adltParam = nsfwEnabled ? 'off' : 'strict';
                    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(args)}&adlt=${adltParam}&first=1&ptn=32&FORM=IARRSM`;
                    
                    const response = await fetch(bingUrl, { 
                        headers: { 
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Accept-Language': 'es-ES,es;q=0.9',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
                        } 
                    });
                    
                    if (!response.ok) {
                        await sock.sendMessage(from, { text: `❌ Bing bloqueó la solicitud (Código ${response.status}).` }, { quoted: msg });
                        return;
                    }

                    const html = await response.text();
                    let matches = [...html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&"]+?\.(?:jpg|jpeg|png))/gi)].map(m => m[1]);
                    
                    matches = matches.filter(url => !url.includes('th?id=') && !url.includes('favicon') && !url.includes('profile'));
                    matches = [...new Set(matches)];

                    if (matches.length > 0) {
                        const url = matches[Math.floor(Math.random() * Math.min(3, matches.length))];
                        await sock.sendMessage(from, { image: { url }, caption: `🔍 *Resultado:* ${args}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No se encontraron imágenes de buena calidad.' }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(from, { text: `❌ Error interno al buscar la imagen: ${e.message}` }, { quoted: msg }); }
                return;
            }

            // 🎵 LETRAS (Sin tiempos)
            if (command === '/letras' || command === '/letra') {
                if (!args) { await sock.sendMessage(from, { text: '⚠️ Ejemplo: `/letra Roberto - Cuarteto de Nos`' }, { quoted: msg }); return; }
                try {
                    let data = [];
                    if (args.includes('-')) {
                        const [cancion, artista] = args.split('-').map(str => str.trim());
                        let res = await fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(cancion)}&artist_name=${encodeURIComponent(artista)}`);
                        if (res.ok) try { data = JSON.parse(await res.text()); } catch(e) {}
                        
                        if (!data.length) {
                            res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cancion + ' ' + artista)}`);
                            if (res.ok) try { data = JSON.parse(await res.text()); } catch(e) {}
                        }
                    } else {
                        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(args)}`);
                        if (res.ok) try { data = JSON.parse(await res.text()); } catch(e) {}
                    }
                    
                    if (!data.length) { await sock.sendMessage(from, { text: `❌ No encontré la canción.` }, { quoted: msg }); return; }
                    
                    const track = data[0];
                    
                    let lyrics = track.plainLyrics;
                    if (!lyrics && track.syncedLyrics) {
                        lyrics = track.syncedLyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
                    }

                    if (lyrics) {
                        await sock.sendMessage(from, { text: `🎵 *${track.trackName}* - ${track.artistName}\n\n${lyrics}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: `❌ La canción no tiene la letra guardada.` }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(from, { text: '❌ Error al buscar la letra.' }, { quoted: msg }); }
                return;
            }

        } catch (globalError) {
            console.error("Error global:", globalError);
        }
    });
}

connectToWhatsApp();
