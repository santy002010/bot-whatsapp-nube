const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay,
    fetchLatestBaileysVersion
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
let modoTrucado = true; // 🔥 NUEVO: Control de respuestas tramposas (activado por defecto)

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

    let version = [2, 3000, 1017551063]; 
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
        console.log(`[SISTEMA] Conectando con WhatsApp Web v${version.join('.')}`);
    } catch (e) {
        console.log(`[ALERTA] No se pudo obtener la última versión, usando respaldo.`);
    }

    const sock = makeWASocket({
        version, 
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, 
        browser: ["Ubuntu", "Chrome", "20.0.04"] 
    });

    // 🌟 INYECCIÓN AUTOMÁTICA DEL PREFIJO [¡+!]
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

    // Mecanismo de Vinculación por Código
    if (!sock.authState.creds.registered) {
        console.log(`[VINCULACIÓN] Detectada falta de sesión. Generando código de emparejamiento...`);
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(HOST_NUMBER);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\n====================================`);
                console.log(`CÓDIGO DE VINCULACIÓN EN RENDER: ${code}`);
                console.log(`====================================\n`);
            } catch (err) {
                console.error('[ERROR] No se pudo generar el código de vinculación:', err.message);
            }
        }, 4000); 
    }

    // Manejo de eventos de conexión
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[CONEXIÓN] Cerrada. Razón/Status Code: ${reason}`);

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

    sock.ev.on('creds.update', saveCreds);

    // Escucha e interpretación de mensajes incoming
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
            const isBanned = bannedList.includes(sender);

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

                // 🔥 COMANDOS NUEVOS: MODO TRUCADO
                if (command === '/modotrucadoon') {
                    modoTrucado = true;
                    await sock.sendMessage(from, { text: '🎭 *Modo Trucado Activado.* Las respuestas arregladas vuelven a funcionar.' }, { quoted: msg });
                    return;
                }

                if (command === '/modotrucadooff') {
                    modoTrucado = false;
                    await sock.sendMessage(from, { text: '⚖️ *Modo Trucado Desactivado.* La ruleta (y las búsquedas) ahora son 100% legales y aleatorias.' }, { quoted: msg });
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

            if (!botEnabled && !isAdmin) return;

            // ==========================================
            // 5. SECCIÓN DE COMANDOS PÚBLICOS
            // ==========================================
            // 🧠 COMANDO GOOGLE (Conectado a la IA Gemini)
            if (command === '/google') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Preguntame lo que quieras. Ejemplo: `/google ¿Por qué el cielo es azul?`' }, { quoted: msg });
                    return;
                }

                const checkText = args.toLowerCase();
                // Huevo de pascua original mantenido intacto
                if (typeof modoTrucado !== 'undefined' && modoTrucado && (checkText.includes('maxi') || checkText.includes('máximo')) && checkText.includes('femboy')) {
                    await sock.sendMessage(from, { text: '🤖 *Respuesta de la IA:*\n\n✨ Analizando mis bases de datos cuánticas: *Sí, Maxi es femboy.* ✨' }, { quoted: msg });
                    return;
                }

                try {
                    const geminiApiKey = 'AIzaSyBTi3jT1d6o5JNSLGFzbfHtmGFpNbP4htY'; 
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
                    const payload = { contents: [{ parts: [{ text: args }] }] };
                    
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    
                    const json = await res.json();
                    
                    if (json.candidates && json.candidates.length > 0) {
                        const aiResponse = json.candidates[0].content.parts[0].text;
                        await sock.sendMessage(from, { text: `🧠 *Inteligencia Artificial:*\n\n${aiResponse}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ Mi cerebro artificial no pudo procesar tu pregunta.' }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ Error al conectarse con la inteligencia artificial.' }, { quoted: msg });
                }
                return;
            }

            // 👽 COMANDO REDDIT (Con filtro inteligente de mayúsculas)
            if (command === '/reddit') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Especificá qué querés buscar en Reddit.' }, { quoted: msg });
                    return;
                }
                
                const isNsfwCommand = (typeof text !== 'undefined' && text.startsWith('/reddIt'));

                if (isNsfwCommand && (typeof nsfwEnabled === 'undefined' || !nsfwEnabled)) {
                    await sock.sendMessage(from, { text: '🔞 *Acceso Denegado.* Este comando requiere que un admin active el `/+18on`.' }, { quoted: msg });
                    return;
                }

                try {
                    let searchUrl = '';
                    if (isNsfwCommand) {
                        searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(args + ' nsfw confesion relato text')}&include_over_18=on&sort=top&limit=25`;
                    } else {
                        searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&sort=hot&limit=25`;
                    }

                    const res = await fetch(searchUrl, { headers: { 'User-Agent': 'BotWhatsApp/1.0.0 (by Maxi)' } });
                    const json = await res.json();
                    let posts = json?.data?.children || [];

                    if (isNsfwCommand) {
                        posts = posts.filter(p => p.data.over_18 && p.data.selftext && p.data.selftext.length > 150);
                    } else if (typeof nsfwEnabled !== 'undefined' && !nsfwEnabled) {
                        posts = posts.filter(p => !p.data.over_18);
                    }

                    if (posts.length === 0) {
                        await sock.sendMessage(from, { text: '❌ No se encontraron resultados o fueron bloqueados por los filtros.' }, { quoted: msg });
                        return;
                    }

                    const randomLimit = Math.min(5, posts.length);
                    const selectedPost = posts[Math.floor(Math.random() * randomLimit)].data;

                    if (selectedPost.url && !selectedPost.is_self && (selectedPost.url.endsWith('.jpg') || selectedPost.url.endsWith('.png'))) {
                        await sock.sendMessage(from, { 
                            image: { url: selectedPost.url }, 
                            caption: `🤖 *${selectedPost.title}*\nSubreddit: r/${selectedPost.subreddit}\nLink: https://reddit.com${selectedPost.permalink}` 
                        }, { quoted: msg });
                    } else {
                        const bodyContent = selectedPost.selftext ? `\n\n${selectedPost.selftext.slice(0, 800)}...` : '';
                        await sock.sendMessage(from, { 
                            text: `🤖 *${selectedPost.title}*\nSubreddit: r/${selectedPost.subreddit}${bodyContent}\n\nLink: https://reddit.com${selectedPost.permalink}` 
                        }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ Error de conexión al buscar en Reddit.' }, { quoted: msg });
                }
                return;
            }

            // 📌 COMANDO PIN (Búsqueda estricta de imágenes en Bing)
            if (command === '/pin') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Especificá la imagen que buscás.' }, { quoted: msg });
                    return;
                }
                try {
                    const adltParam = (typeof nsfwEnabled !== 'undefined' && nsfwEnabled) ? 'off' : 'strict';
                    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(args)}&adlt=${adltParam}`;
                    
                    const response = await fetch(bingUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    const html = response.ok ? await response.text() : '';
                    
                    const regex = /murl&quot;:&quot;(https?:\/\/[^&]+?\.(?:jpg|jpeg|png))/gi;
                    let matches = [];
                    let match;
                    while ((match = regex.exec(html)) !== null) { matches.push(match[1]); }
                    matches = [...new Set(matches)];

                    if (matches.length > 0) {
                        const index = Math.floor(Math.random() * Math.min(4, matches.length));
                        await sock.sendMessage(from, { image: { url: matches[index] }, caption: `🔍 *Resultado:* ${args}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No se encontraron imágenes coherentes.' }, { quoted: msg });
                    }
                } catch (err) {
                    await sock.sendMessage(from, { text: '❌ Error interno al procesar las imágenes.' }, { quoted: msg });
                }
                return;
            }



            if (command === '/letras' || command === '/letra') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Especificá qué canción querés buscar. Ejemplo: `/letra Roberto - Cuarteto de Nos`' }, { quoted: msg });
                    return;
                }
                try {
                    let data = [];
                    
                    // Si usás guion, intentamos la búsqueda súper exacta primero
                    if (args.includes('-')) {
                        const [cancion, artista] = args.split('-').map(str => str.trim());
                        const exactUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cancion)}&artist_name=${encodeURIComponent(artista)}`;
                        
                        let res = await fetch(exactUrl);
                        if (res.ok) {
                            try { data = JSON.parse(await res.text()); } catch(e) {}
                        }
                        
                        // 🔥 PLAN B: Si la exacta falló (por un typo o nombre raro), probamos una búsqueda general flexible
                        if (!Array.isArray(data) || data.length === 0) {
                            const fallbackUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cancion + ' ' + artista)}`;
                            res = await fetch(fallbackUrl);
                            if (res.ok) {
                                try { data = JSON.parse(await res.text()); } catch(e) {}
                            }
                        }
                    } else {
                        // Si no pusiste guion, va directo a la general
                        const generalUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(args)}`;
                        const res = await fetch(generalUrl);
                        if (res.ok) {
                            try { data = JSON.parse(await res.text()); } catch(e) {}
                        }
                    }
                    
                    if (!Array.isArray(data) || data.length === 0) {
                        await sock.sendMessage(from, { text: `❌ No encontré la canción. Revisá que la ortografía del artista y la canción estén bien.` }, { quoted: msg });
                        return;
                    }
                    
                    const song = data.find(s => s.plainLyrics);

                    if (song) {
                        const titulo = song.trackName || song.name || 'Desconocido';
                        const responseText = `🎵 *${titulo}* - _${song.artistName}_\n\n${song.plainLyrics}`;
                        await sock.sendMessage(from, { text: responseText }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ Encontré la canción, pero lamentablemente nadie le subió la letra todavía 🥺' }, { quoted: msg });
                    }
                } catch (err) {
                    console.error('[LETRAS ERROR]', err);
                    await sock.sendMessage(from, { text: '❌ Ocurrió un error interno en el buscador de letras.' }, { quoted: msg });
                }
                return;
            }




 
           if (command === '/ruleta') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Hacé una pregunta. Podés agregar la probabilidad al final (ej: `/ruleta apruebo? 1;10`).' }, { quoted: msg });
                    return;
                }

                const match = args.match(/(\d+);(\d+)\s*$/);
                let siChance = 1;
                let totalChance = 2; 
                let pregunta = args;

                if (match) {
                    siChance = parseInt(match[1]);
                    totalChance = parseInt(match[2]);
                    pregunta = args.replace(/(\d+);(\d+)\s*$/, '').trim();

                    if (siChance > totalChance || siChance <= 0 || totalChance <= 0) {
                        await sock.sendMessage(from, { text: '⚠️ Probabilidades inválidas. El formato correcto es `1;10`.' }, { quoted: msg });
                        return;
                    }
                }

                const checkMsg = pregunta.toLowerCase();
                let resultado = '';

                // 🔥 LÓGICA DEL MODO TRUCADO (Frases forzadas a salir SIEMPRE SÍ)
                const isRiggedQuestion = (
                    (checkMsg.includes('maxi') && checkMsg.includes('femboy')) ||
                    (checkMsg.includes('dylan') && checkMsg.includes('perra')) ||
                    (checkMsg.includes('omeguita'))
                );

                if (modoTrucado && isRiggedQuestion) {
                    // Ignora el azar por completo
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

connectToWhatsApp();
