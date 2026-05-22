const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');

// --- 1. SERVIDOR ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.status(200).send('<h1>Bot WhatsApp Pro esta ONLINE 🚀</h1>'));
app.listen(PORT, () => console.log(`[SERVER] Monitor activo en puerto ${PORT}`));

// --- 2. CONFIGURACIÓN ---
const GRUPO_PERMITIDO = '120363426591951143@g.us'; 
let botActivo = true;       
let nsfwPermitido = false;  

// --- 3. BANEOS ---
const banFile = './auth_session/baneados.json';
let baneados = [];
try { 
    if (fs.existsSync(banFile)) {
        const fileContent = fs.readFileSync(banFile, 'utf-8');
        baneados = fileContent ? JSON.parse(fileContent) : [];
    }
} catch(e) {}

function guardarBaneos() {
    try { 
        if (!fs.existsSync('./auth_session')) fs.mkdirSync('./auth_session');
        fs.writeFileSync(banFile, JSON.stringify(baneados, null, 2)); 
    } catch(e) {}
}

// --- 4. MOTORES DE BÚSQUEDA (CORREGIDOS) ---

// Reddit 
async function searchReddit(query, allowNsfw) {
    try {
        const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance`);
        const json = await res.json();
        const posts = json.data?.children || [];
        for (const post of posts) {
            const data = post.data;
            if (data.over_18 && !allowNsfw) continue; 
            if (data.url && data.url.match(/\.(jpeg|jpg|gif|png)$/i)) return { url: data.url, title: data.title };
        }
        return null;
    } catch (e) { return null; }
}

// Pinterest (Truco: Busca en Bing de fondo para evitar bloqueos)
async function searchPinterest(query) {
    try {
        const res = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const html = await res.text();
        // Extrae enlaces a imágenes jpg o png gigantes
        const regex = /(https:\/\/[^"'\s&<>]+\.(?:jpg|jpeg|png))/gi;
        const matches = [...html.matchAll(regex)];
        
        // Filtramos para evitar que devuelva miniaturas chiquitas
        const validImages = matches.map(m => m[1]).filter(url => !url.includes('th.bing.com') && !url.includes('profile_images'));
        return validImages.length > 0 ? validImages[0] : (matches.length > 0 ? matches[0][1] : null);
    } catch (e) { return null; }
}

// Google (Inteligente: Limpia la pregunta antes de buscar)
async function searchGoogle(query) {
    try {
        // Le saca el "que es" o "quien es" para que no falle la búsqueda
        let cleanQuery = query.replace(/^(qué es|que es|quién es|quien es|qué significa|que significa)\s+(un|una|el|la|los|las)?\s*/i, '').trim();
        if (!cleanQuery) cleanQuery = query;

        const wikiRes = await fetch(`https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&utf8=&format=json`);
        const wikiJson = await wikiRes.json();
        
        if (wikiJson.query && wikiJson.query.search.length > 0) {
            const title = wikiJson.query.search[0].title;
            const summaryRes = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
            const summaryJson = await summaryRes.json();
            if (summaryJson.extract) {
                return `🔍 *Resultado de: ${title}*\n\n📝 ${summaryJson.extract}`;
            }
        }
        return "❌ No encontré resultados exactos. Intenta usar solo palabras clave (Ej: 'Gato' en vez de 'Qué es un gato').";
    } catch(e) { return "❌ Ocurrió un error al conectar con la base de datos."; }
}

// --- 5. NÚCLEO ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode('5491128394646');
                console.log('\n==================================================');
                console.log(`🔑 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log('==================================================\n');
            } catch (error) { console.error('[ERROR]', error.message); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            startBot(); // Solo se reconecta internamente
        } else if (connection === 'open') {
            console.log('\n🚀 [SISTEMA] ¡BOT ONLINE EN TU GRUPO! 🚀\n');
        }
    });

    // --- 6. COMANDOS ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const chatId = msg.key.remoteJid;
        if (chatId !== GRUPO_PERMITIDO) return; 

        const miNumeroLimpio = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '5491128394646@s.whatsapp.net';
        const sender = msg.key.participant || (msg.key.fromMe ? miNumeroLimpio : msg.key.remoteJid); 
        const esAdmin = msg.key.fromMe || sender.includes('1128394646') || sender === miNumeroLimpio; 

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption;
        if (!text || !text.startsWith('/')) return;

        const args = text.slice(1).split(/ +/);
        const command = args.shift().toLowerCase();
        const query = args.join(' ');

        const citado = msg.message.extendedTextMessage?.contextInfo;
        const usuarioCitado = citado?.participant;

        // 🔒 ADMIN
        if (['on', 'off', 'restart', 'restard', '+18on', '+18off', 'ban', 'unban'].includes(command)) {
            if (!esAdmin) return await sock.sendMessage(chatId, { text: '❌ No tenés autorización.' });

            switch(command) {
                case 'on':
                    botActivo = true;
                    return await sock.sendMessage(chatId, { text: '🟢 *Bot Encendido.*' });
                
                case 'off':
                    botActivo = false;
                    return await sock.sendMessage(chatId, { text: '🔴 *Bot Apagado.*' });
                
                case 'restart':
                case 'restard':
                    // 🔥 ACÁ ESTÁ EL ARREGLO: Ya no mata el servidor para evitar que se desvincule
                    return await sock.sendMessage(chatId, { text: '✅ *Sistema estable.* UptimeRobot está manteniendo el bot despierto. ¡No hace falta reiniciar!' });
                
                case '+18on':
                    nsfwPermitido = true;
                    return await sock.sendMessage(chatId, { text: '🔞 *Modo +18 Activado.*' });
                
                case '+18off':
                    nsfwPermitido = false;
                    return await sock.sendMessage(chatId, { text: '🛡️ *Modo +18 Desactivado.*' });

                case 'ban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Respondé al mensaje de la persona que quieras banear del bot.' });
                    if (usuarioCitado.includes('1128394646') || usuarioCitado === miNumeroLimpio) {
                        return await sock.sendMessage(chatId, { text: '❌ No podés banearte a vos mismo.' });
                    }
                    if (!baneados.includes(usuarioCitado)) {
                        baneados.push(usuarioCitado);
                        guardarBaneos();
                    }
                    return await sock.sendMessage(chatId, { text: `🔨 *Usuario añadido a la Lista Negra.*` });

                case 'unban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Respondé a un mensaje del usuario.' });
                    baneados = baneados.filter(u => u !== usuarioCitado);
                    guardarBaneos();
                    return await sock.sendMessage(chatId, { text: '✅ *Usuario perdonado.*' });
            }
        }

        if (!botActivo) return;

        // 🛡️ AVISO AL BANEADO
        if (baneados.includes(sender)) {
            if (!esAdmin) {
                return await sock.sendMessage(chatId, { text: '🚫 *Acceso denegado:* Estás baneado del bot.' });
            }
        }

        // 🌍 BÚSQUEDAS
        switch (command) {
            case 'google':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ ¿Qué querés buscar?' });
                const resGoogle = await searchGoogle(query);
                await sock.sendMessage(chatId, { text: resGoogle });
                break;

            case 'reddit':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/reddit gatos`' });
                const resReddit = await searchReddit(query, nsfwPermitido);
                if (resReddit) {
                    await sock.sendMessage(chatId, { image: { url: resReddit.url }, caption: `🤖 *Reddit:* ${resReddit.title}` });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ Filtro +18 activo o sin resultados.' });
                }
                break;

            case 'pin':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/pin paisaje`' });
                const imgPin = await searchPinterest(query);
                if (imgPin) {
                    await sock.sendMessage(chatId, { image: { url: imgPin }, caption: `📌 *Imágenes:* ${query}` });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ No encontré imágenes.' });
                }
                break;
        }
    });
}

startBot();
