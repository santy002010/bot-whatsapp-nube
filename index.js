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

    // Inyección automática del prefijo en cada mensaje saliente
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

// 1. ACORDATE: Esta variable va arriba de todo, AFUERA de la función de conectar
let codigoSolicitado = false; 


// 2. REEMPLAZÁ TU BLOQUE DE 'connection.update' COMPLETO POR ESTE:
sock.ev.on('connection.update', async (update) => {
    // Es desde acá adentro de donde nace la variable "connection"
    const { connection, lastDisconnect } = update; 

    // ✅ EL RESETEO VA ACÁ ADENTRO (Donde la variable sí existe)
    if (connection === 'close') {
        codigoSolicitado = false; // Limpiamos el candado para que pueda volver a pedir código si se cae
        console.log('[SISTEMA] Conexión cerrada. Intentando reconectar...');
        
        // Dejá acá abajo tu lógica vieja de reconexión, por ejemplo:
        const buscarError = lastDisconnect?.error?.output?.statusCode;
        if (buscarError !== 401) { // 401 es Logged Out (Sesión cerrada en el cel)
            connectToWhatsApp();
        }
        return;
    }

    if (connection === 'open') {
        console.log('[SISTEMA] ¡Bot conectado con éxito a WhatsApp!');
        codigoSolicitado = false;
        return;
    }

    // 🔒 EL BLOQUE DEL CÓDIGO DE VINCULACIÓN (Queda protegido acá también)
    if (!sock.authState.creds.registered && !codigoSolicitado) {
        codigoSolicitado = true; // Cerramos el candado para evitar códigos duplicados

        setTimeout(async () => {
            try {
                const numeroLimpio = HOST_NUMBER.replace(/[^0-9]/g, '');
                console.log(`[SISTEMA] Solicitando código seguro para: ${numeroLimpio}`);
                
                let code = await sock.requestPairingCode(numeroLimpio);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                console.log(`\n====================================`);
                console.log(`🔥 TU CÓDIGO DE VINCULACIÓN: ${code.toUpperCase()} 🔥`);
                console.log(`====================================\n`);
            } catch (err) {
                console.error(`❌ Error al generar el código de vinculación:`, err.message);
                codigoSolicitado = false; // Si falla, abrimos el candado para reintentar
            }
        }, 6000); // Espera estratégica de 6 segundos
    }
});


// 3. EN LA PARTE DONDE CORTE LA CONEXIÓN (connection === 'close'), ACORDATE DE RESETEARLO:
if (connection === 'close') {
    codigoSolicitado = false; // Reseteamos el candado si el bot se apaga o se cae
    // ... acá va tu lógica existente para reiniciar el bot ...
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
    // 3. INTERPRETACIÓN DE MENSAJES Y COMANDOS
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

            // --- COMANDOS PÚBLICOS ---

            // 🎲 RULETA (Modo Trucado)
            if (command === '/ruleta') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Escribí algo para la ruleta. Ejemplo: `/ruleta ¿Va a llover? 1;100`' }, { quoted: msg });
                    return;
                }

                let resultadoFinal = "";
                let probabilidadMostrada = "";
                let pregunta = args;

                const probMatch = args.match(/(\d+);(\d+)\s*$/);
                let siChance = 1;
                let totalChance = 2;
                let tieneProbabilidad = false;

                if (probMatch) {
                    siChance = parseInt(probMatch[1]);
                    totalChance = parseInt(probMatch[2]);
                    pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();
                    probabilidadMostrada = ` (Probabilidad: ${siChance};${totalChance})`;
                    tieneProbabilidad = true;
                }

                let esTrucado = false;
                if (modoTrucado) {
                    const textoBajo = pregunta.toLowerCase();
                    if (((textoBajo.includes('maxi') || textoBajo.includes('máximo')) && textoBajo.includes('femboy')) ||
                        (textoBajo.includes('dylan') && textoBajo.includes('perra')) ||
                        (textoBajo.includes('omeguita'))) {
                        resultadoFinal = "🔴 si";
                        esTrucado = true;
                    }
                }

                if (!esTrucado) {
                    if (tieneProbabilidad) {
                        const rand = Math.floor(Math.random() * totalChance) + 1;
                        resultadoFinal = (rand <= siChance) ? "🔴 si" : "⚫ no";
                    } else {
                        const respuestas = ["🔴 si", "⚫ no"];
                        resultadoFinal = respuestas[Math.floor(Math.random() * respuestas.length)];
                    }
                }

                const mensajeRespuesta = `🎰 *Ruleta:* ${pregunta}\n\n🎲 Resultado: *${resultadoFinal}*${probabilidadMostrada}`;
                await sock.sendMessage(from, { text: mensajeRespuesta }, { quoted: msg });
                return;
            }

        //         //         // ==========================================
        // CONFIGURACIÓN DE APIS (Usa la variable de entorno de Render)
        // ==========================================
        const MI_GEMINI_KEY = process.env.GEMINI_KEY; 

        // 🧠 GOOGLE (¡Actualizado a Gemini 3.5 Flash!)
        if (command === '/google') {
            if (!args) { await sock.sendMessage(from, { text: '⚠️ Preguntame lo que quieras.' }, { quoted: msg }); return; }

            if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
                await sock.sendMessage(from, { text: '▼⁠・⁠ᴥ⁠·⁠▼\n\n✨ Analizando mis bases de datos: *Sí, Maxi es femboy.* ✨' }, { quoted: msg });
                return;
            }

            try {
                // Apuntamos al modelo 3.5 Flash que ves en tu captura
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${MI_GEMINI_KEY}`;

                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: args }] }] })
                });

                const json = await res.json();

                if (json.error) {
                    await sock.sendMessage(from, { text: `❌ Error de Google API:\n${json.error.message}\n\n💡 Tip: Si persiste, revisá en los logs de Render qué código de error tira.` }, { quoted: msg });
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
            return;
        }

        // 🌟 GOOGLE PRO (¡Actualizado a Gemini 3.1 Pro!)
        if (command === '/googlep') {
            if (!args) { await sock.sendMessage(from, { text: '⚠️ Preguntame lo que quieras para el modelo PRO.' }, { quoted: msg }); return; }

            if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
                await sock.sendMessage(from, { text: '▼⁠・⁠ᴥ⁠·⁠▼\n\n✨ Analizando mis bases de datos avanzadas: *Efectivamente, Maxi es femboy.* ✨' }, { quoted: msg });
                return;
            }

            try {
                // Apuntamos al modelo 3.1 Pro de tu captura
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${MI_GEMINI_KEY}`;

                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: args }] }] })
                });

                const json = await res.json();

                if (json.error) {
                    await sock.sendMessage(from, { text: `❌ Error en Google PRO:\n${json.error.message}` }, { quoted: msg });
                    return;
                }

                if (json.candidates && json.candidates[0]?.content?.parts?.[0]?.text) {
                    await sock.sendMessage(from, { text: `▼⁠・⁠ᴥ⁠·⁠▼\n\n${json.candidates[0].content.parts[0].text}` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: '❌ No pude procesar tu pregunta en la versión PRO.' }, { quoted: msg });
                }
            } catch (e) { 
                await sock.sendMessage(from, { text: `❌ Fallo en fetch PRO: ${e.message}` }, { quoted: msg }); 
            }
            return;
        }

        // 👽 REDDIT (User-Agent modificado para evitar el baneo de Render)
        if (command === '/reddit') {
            if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar en Reddit.' }, { quoted: msg }); return; }
            const isNsfwCommand = originalCommand === '/reddIt';

            if (isNsfwCommand && !nsfwEnabled) {
                await sock.sendMessage(from, { text: '🔞 *Denegado.* Requiere `/+18on`.' }, { quoted: msg }); return;
            }

            try {
                let url = `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&limit=40&raw_json=1`;

                const res = await fetch(url, {
                    headers: { 
                        // Usamos un identificador único de bot para que Reddit no nos meta el 403 instantáneo en Render
                        'User-Agent': 'whatsapp:bot:instincktt-sub:v1.0.0 (by /u/instincktt_bot)'
                    }
                });

                if (!res.ok) {
                    await sock.sendMessage(from, { text: `❌ Reddit bloqueó el acceso (Código ${res.status}).\nMotivo: El servidor de Render está temporalmente en lista negra de la plataforma.` }, { quoted: msg }); return;
                }

                const json = await res.json();
                let children = json?.data?.children || [];
                let posts = children.map(child => child.data);

                posts = isNsfwCommand 
                    ? posts.filter(p => p.over_18)
                    : posts.filter(p => !p.over_18);

                if (!posts.length) { await sock.sendMessage(from, { text: '❌ Sin resultados aptos para esa búsqueda.' }, { quoted: msg }); return; }

                const post = posts[Math.floor(Math.random() * Math.min(15, posts.length))];
                const permalink = `https://reddit.com${post.permalink}`;
                const suffix = `\n\nSubreddit: r/${post.subreddit}\nLink: ${permalink}`;

                const tieneImagen = post.url && (post.url.endsWith('.jpg') || post.url.endsWith('.png') || post.url.endsWith('.jpeg') || post.url.includes('i.redd.it'));

                if (tieneImagen) {
                    await sock.sendMessage(from, { image: { url: post.url }, caption: `🤖 *${post.title}*${suffix}` }, { quoted: msg });
                } else {
                    const body = post.selftext ? `\n\n${post.selftext.slice(0, 500)}...` : '';
                    await sock.sendMessage(from, { text: `🤖 *${post.title}*${body}${suffix}` }, { quoted: msg });
                }
            } catch (e) { 
                await sock.sendMessage(from, { text: `❌ Error de conexión con Reddit: ${e.message}` }, { quoted: msg }); 
            }
            return;
        }

        // 📌 PIN (Headers reforzados para romper el bloqueo de Cloudflare)
        if (command === '/pin') {
            if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar en Pinterest.' }, { quoted: msg }); return; }
            try {
                const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(args)}`;
                const response = await fetch(url, { 
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'es-ES,es;q=0.8,en;q=0.5'
                    }
                });

                if (!response.ok) {
                    await sock.sendMessage(from, { text: `❌ Pinterest rechazó la consulta (Código ${response.status}).\nMotivo: Seguridad de Cloudflare activa en el hosting.` }, { quoted: msg });
                    return;
                }

                const html = await response.text();
                let matches = [...html.matchAll(/https?:\\?\/\\?\/i\.pinimg\.com\\?\/[^"'\s>]+/gi)].map(m => m[0].replace(/\\/g, ''));
                
                matches = matches.filter(link => link.includes('/736x/') || link.includes('/474x/') || link.includes('/originals/'));
                matches = [...new Set(matches)]; 

                if (matches.length > 0) {
                    const imgUrl = matches[Math.floor(Math.random() * Math.min(10, matches.length))];
                    await sock.sendMessage(from, { image: { url: imgUrl }, caption: `📌 *Pinterest:* ${args}` }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: '❌ No se encontraron imágenes legibles para esa búsqueda.' }, { quoted: msg });
                }
            } catch (e) { 
                await sock.sendMessage(from, { text: `❌ Error al buscar en Pinterest: ${e.message}` }, { quoted: msg }); 
            }
            return;
        }

            // 🎵 LETRAS (API lrclib)
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
                } catch (e) { await sock.sendMessage(from, { text: `❌ Error al buscar letras: ${e.message}` }, { quoted: msg }); }
                return;
            }

        } catch (err) {
            console.error(`Error en el manejador de mensajes: ${err.message}`);
        }
    });
}

connectToWhatsApp();
