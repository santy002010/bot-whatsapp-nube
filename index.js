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
const app = report = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Bot de WhatsApp Operando de manera Correcta.');
});

app.listen(PORT, () => {
    console.log(`[EXPRESS] Servidor web listo en el puerto ${PORT} (Mantiene el bot 24/7)`);
});

// CHATS PERMITIDOS (El grupo y tu propio número para el auto-chat)
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
        
        // 🌟 INSTRUCCIONES ESTRICTAS PARA TRADUCIR A FORMATO WHATSAPP LIMPIO
        const sistemaPrompt = `REGLAS OBLIGATORIAS DE RESPUESTA:
1. Actúa como una persona normal respondiendo un mensaje.
2. NUNCA digas que sos una IA, un bot, un modelo de lenguaje, ni menciones a Google.
3. FORMATO WHATSAPP LIMPIO: No uses títulos con '#' o '##'. No uses bloques de código con tres comillas (\`\`\`). No uses listas con guiones largos o símbolos raros de Markdown que se rompen en celulares.
4. Si querés resaltar algo, usá ÚNICAMENTE el asterisco para poner texto en *negrita* de WhatsApp. El resto tiene que ser texto plano, fluido, legible y directo.

Consulta del usuario: ${args}`;

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: sistemaPrompt }] }] })
        });
        const json = await res.json();

        if (json.error) throw new Error(json.error.message);
        let text = json.candidates[0]?.content?.parts?.[0]?.text;
        
        if (text) {
            // Limpieza extra por las dudas de remanentes de markdown pesado
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
    if (!args) return await sock.sendMessage(from, { text: '⚠️ Formato: /letras [canción] o /letras [canción - artista]' }, { quoted: msg });
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
        const res = await fetch(url, { headers: { 'User-Agent': 'whatsapp:bot:instincktt-sub:v1.0.0' } });
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
        const res = await fetch(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });
        if (!res.ok) throw new Error(`Pinterest rechazó la consulta (Código ${res.status}).`);

        const html = await res.text();
        let matches = [...html.matchAll(/https?:\\?\/\\?\/i\.pinimg\.com\\?\/[^"'\s>]+/gi)]
                        .map(m => m[0].replace(/\\/g, ''))
                        .filter(link => link.includes('/736x/') || link.includes('/474x/') || link.includes('/originals/'));
        matches = [...new Set(matches)]; 

        if (matches.length > 0) {
            const imgUrl = matches[Math.floor(Math.random() * Math.min(10, matches.length))];
            await sock.sendMessage(from, { image: { url: imgUrl }, caption: `📌 Pinterest: *${args}*` }, { quoted: msg });
        } else await sock.sendMessage(from, { text: '❌ No se encontraron imágenes.' }, { quoted: msg });
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

async function handleTest(sock, from, msg) {
    await sock.sendMessage(from, { text: '🔄 Ejecutando diagnóstico de APIs. Dame un segundo...' }, { quoted: msg });
    let reporte = "📊 *REPORTE DE SISTEMA*\n\n";

    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${MI_GEMINI_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: "hola" }] }] })
        });
        reporte += res.ok ? "✅ Gemini (Google): Operativo\n" : `❌ Gemini: Fallo API (${res.status})\n`;
    } catch(e) { reporte += `❌ Gemini: Error (${e.message})\n`; }

    try {
        const res = await fetch(`https://lrclib.net/api/search?q=test`);
        reporte += res.ok ? "✅ Letras (LrcLib): Operativo\n" : `❌ Letras: Fallo servidor (${res.status})\n`;
    } catch(e) { reporte += `❌ Letras: Error (${e.message})\n`; }

    try {
        const res = await fetch(`https://www.reddit.com/r/all/hot.json?limit=1`, { headers: { 'User-Agent': 'whatsapp:bot:test' } });
        reporte += res.ok ? "✅ Reddit: Operativo\n" : `❌ Reddit: Fallo conexión (${res.status})\n`;
    } catch(e) { reporte += `❌ Reddit: Error (${e.message})\n`; }

    try {
        const res = await fetch(`https://www.pinterest.com/search/pins/?q=gato`);
        reporte += res.ok ? "✅ Pinterest: Operativo\n" : `❌ Pinterest: Bloqueado (${res.status})\n`;
    } catch(e) { reporte += `❌ Pinterest: Error (${e.message})\n`; }

    await sock.sendMessage(from, { text: reporte }, { quoted: msg });
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

    // 🌟 INYECTOR DEL PREFIJO [¡+!] OBLIGATORIO Y SEGURO
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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update; 
        if (connection === 'close') {
            codigoSolicitado = false; 
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(() => connectToWhatsApp(), 10000); 
            return;
        }
        if (connection === 'open') {
            console.log('[SISTEMA] ¡Bot conectado con éxito a WhatsApp! 🎉');
            codigoSolicitado = false;
        }
        if (!sock.authState.creds.registered && !codigoSolicitado && connection !== 'close') {
            codigoSolicitado = true; 
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(HOST_NUMBER.replace(/[^0-9]/g, ''));
                    console.log(`\n🔥 TU CÓDIGO DE VINCULACIÓN ACTUAL: ${code?.match(/.{1,4}/g)?.join('-').toUpperCase() || code} 🔥\n`);
                } catch (err) { codigoSolicitado = false; }
            }, 8000); 
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
            
            // Si te enviás un mensaje a vos mismo y NO arranca con '/', se ignora para evitar bucles.
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

            // ==========================================
            // 📝 LISTA DE COMANDOS FÁCIL DE EDITAR
            // ==========================================
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
                '/test': () => handleTest(sock, from, msg)
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
