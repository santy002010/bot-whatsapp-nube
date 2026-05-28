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

    // Inyección Automática del Prefijo [¡+!]
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

    // Emparejamiento
    if (!sock.authState.creds.registered) {
        console.log(`[VINCULACIÓN] Generando código...`);
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(HOST_NUMBER);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\n====================================`);
                console.log(`CÓDIGO DE VINCULACIÓN: ${code}`);
                console.log(`====================================\n`);
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
        } else if (connection === 'open') {
            console.log('[CONEXIÓN] Bot conectado exitosamente.');
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

            // Identificar al que envía (y evitar ignorarte a ti mismo)
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

            // 🎲 RULETA (Con Lore Integrado)
            if (command === '/ruleta') {
                if (!args) {
                    await sock.sendMessage(from, { text: '⚠️ Escribí opciones separadas por comas o haceme una pregunta.' }, { quoted: msg });
                    return;
                }
                const checkText = args.toLowerCase();

                if (modoTrucado) {
                    const trampaMaxi = (checkText.includes('maxi') || checkText.includes('máximo')) && checkText.includes('femboy');
                    const trampaDylan = checkText.includes('dylan') && checkText.includes('perra');
                    const trampaBot = (checkText.includes('bot') || checkText.includes('ia') || checkText.includes('vos')) && checkText.includes('omeguita');

                    if (trampaMaxi || trampaDylan || trampaBot) {
                        await sock.sendMessage(from, { text: `🎲 *Haciendo girar la ruleta...*\n\n🎯 Cayó en: *¡Sí, absolutamente!* ✨` }, { quoted: msg });
                        return;
                    }
                }

                let opciones = args.split(',').map(op => op.trim()).filter(op => op !== '');
                if (opciones.length < 2) {
                    opciones = ['Sí', 'No', 'Tal vez', 'Definitivamente no', 'Claro que sí', 'Ni lo sueñes'];
                }
                const seleccion = opciones[Math.floor(Math.random() * opciones.length)];
                await sock.sendMessage(from, { text: `🎲 *Haciendo girar la ruleta...*\n\n🎯 Cayó en: *${seleccion}*` }, { quoted: msg });
                return;
            }

            // 🧠 GOOGLE (Gemini)
            if (command === '/google') {
                if (!args) { await sock.sendMessage(from, { text: '⚠️ Preguntame lo que quieras.' }, { quoted: msg }); return; }

                if (modoTrucado && (args.toLowerCase().includes('maxi') || args.toLowerCase().includes('máximo')) && args.toLowerCase().includes('femboy')) {
                    await sock.sendMessage(from, { text: '🤖 *IA:*\n\n✨ Analizando mis bases de datos: *Sí, Maxi es femboy.* ✨' }, { quoted: msg });
                    return;
                }

                try {
                    const geminiApiKey = 'AIzaSyBTi3jT1d6o5JNSLGFzbfHtmGFpNbP4htY'; 
                    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: args }] }] })
                    });
                    const json = await res.json();
                    if (json.candidates) {
                        await sock.sendMessage(from, { text: `🧠 *IA:*\n\n${json.candidates[0].content.parts[0].text}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No pude procesar tu pregunta.' }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(from, { text: '❌ Error de conexión.' }, { quoted: msg }); }
                return;
            }

            // 👽 REDDIT
            if (command === '/reddit') {
                if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá qué buscar.' }, { quoted: msg }); return; }
                const isNsfwCommand = text.startsWith('/reddIt');

                if (isNsfwCommand && !nsfwEnabled) {
                    await sock.sendMessage(from, { text: '🔞 *Denegado.* Requiere `/+18on`.' }, { quoted: msg }); return;
                }

                try {
                    const url = isNsfwCommand 
                        ? `https://www.reddit.com/search.json?q=${encodeURIComponent(args + ' nsfw confesion relato text')}&include_over_18=on&sort=top&limit=25`
                        : `https://www.reddit.com/search.json?q=${encodeURIComponent(args)}&sort=hot&limit=25`;

                    const res = await fetch(url, { headers: { 'User-Agent': 'BotWhatsApp/1.0' } });
                    const json = await res.json();
                    let posts = json?.data?.children || [];

                    posts = isNsfwCommand 
                        ? posts.filter(p => p.data.over_18 && p.data.selftext?.length > 150)
                        : posts.filter(p => !p.data.over_18);

                    if (!posts.length) { await sock.sendMessage(from, { text: '❌ Sin resultados.' }, { quoted: msg }); return; }

                    const post = posts[Math.floor(Math.random() * Math.min(5, posts.length))].data;
                    const suffix = `\nSubreddit: r/${post.subreddit}\nLink: https://reddit.com${post.permalink}`;

                    if (post.url && !post.is_self && (post.url.endsWith('.jpg') || post.url.endsWith('.png'))) {
                        await sock.sendMessage(from, { image: { url: post.url }, caption: `🤖 *${post.title}*${suffix}` }, { quoted: msg });
                    } else {
                        const body = post.selftext ? `\n\n${post.selftext.slice(0, 800)}...` : '';
                        await sock.sendMessage(from, { text: `🤖 *${post.title}*${body}${suffix}` }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(from, { text: '❌ Error en Reddit.' }, { quoted: msg }); }
                return;
            }

            // 📌 PIN (BING IMÁGENES)
            if (command === '/pin') {
                if (!args) { await sock.sendMessage(from, { text: '⚠️ Especificá la imagen.' }, { quoted: msg }); return; }
                try {
                    const adltParam = nsfwEnabled ? 'off' : 'strict';
                    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(args)}&adlt=${adltParam}`;
                    
                    const response = await fetch(bingUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    const html = response.ok ? await response.text() : '';
                    
                    let matches = [...html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&]+?\.(?:jpg|jpeg|png))/gi)].map(m => m[1]);
                    matches = [...new Set(matches)];

                    if (matches.length > 0) {
                        const url = matches[Math.floor(Math.random() * Math.min(4, matches.length))];
                        await sock.sendMessage(from, { image: { url }, caption: `🔍 *Resultado:* ${args}` }, { quoted: msg });
                    } else {
                        await sock.sendMessage(from, { text: '❌ No se encontraron imágenes.' }, { quoted: msg });
                    }
                } catch (e) { await sock.sendMessage(from, { text: '❌ Error interno.' }, { quoted: msg }); }
                return;
            }

            // 🎵 LETRAS
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
                    const lyrics = track.syncedLyrics || track.plainLyrics;
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
