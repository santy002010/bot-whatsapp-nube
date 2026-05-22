const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');

// --- 1. SERVIDOR DE MONITOREO (Para mantener vivo el bot en Render) ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot Privado Pro Activo v2 🚀'));
app.listen(PORT, () => console.log(`[SERVER] Monitor activo en puerto ${PORT}`));

// --- 2. CONFIGURACIÓN DE SEGURIDAD ---
const GRUPO_PERMITIDO = '120363426591951143@g.us'; 

let botActivo = true;       
let nsfwPermitido = false;  

// --- 3. SISTEMA DE BANEOS (Lista Negra en disco persistente) ---
const banFile = './auth_session/baneados.json';
let baneados = [];
try { 
    if (fs.existsSync(banFile)) {
        const fileContent = fs.readFileSync(banFile, 'utf-8');
        baneados = fileContent ? JSON.parse(fileContent) : [];
    }
} catch(e) { console.log('[SISTEMA] Creando nueva base de datos de baneos.'); }

function guardarBaneos() {
    try { 
        if (!fs.existsSync('./auth_session')) fs.mkdirSync('./auth_session');
        fs.writeFileSync(banFile, JSON.stringify(baneados, null, 2)); 
    } catch(e) { console.error('[ERROR] No se pudo guardar la lista negra:', e.message); }
}

// --- 4. MOTORES DE BÚSQUEDA AVANZADOS ---

// Reddit Pro (Imágenes directas)
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

// Pinterest Pro (Scraper con simulación de navegador)
async function searchPinterest(query) {
    try {
        const res = await fetch(`https://ar.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = await res.text();
        const regex = /https:\/\/i\.pinimg\.com\/[^\s"'>]+\.(jpg|jpeg|png)/gi;
        const matches = html.match(regex);
        if (matches && matches.length > 0) {
            const highRes = matches.filter(url => url.includes('originals') || url.includes('736x'));
            return highRes.length > 0 ? highRes[0] : matches[0];
        }
        return null;
    } catch (e) { return null; }
}

// Google Pro (Híbrido DuckDuckGo API + Wikipedia - Antiban de Servidores)
async function searchGoogle(query) {
    try {
        // Intento 1: API de Respuestas Rápidas (DuckDuckGo)
        const ddgRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
        const ddgJson = await ddgRes.json();
        
        if (ddgJson.AbstractText) {
            return `🔍 *Resultado de Búsqueda:* ${ddgJson.Heading}\n\n📝 ${ddgJson.AbstractText}`;
        }
        
        // Intento 2: Fallback Inteligente a Wikipedia en Español
        const wikiSearch = await fetch(`https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`);
        const wikiSearchJson = await wikiSearch.json();
        
        if (wikiSearchJson.query && wikiSearchJson.query.search.length > 0) {
            const title = wikiSearchJson.query.search[0].title;
            const wikiSummary = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
            const wikiJson = await wikiSummary.json();
            if (wikiJson.extract) {
                return `🔍 *Información: ${title}*\n\n📝 ${wikiJson.extract}`;
            }
        }
        
        return "❌ No encontré resultados rápidos para esa búsqueda en la red. Intentá con otros términos.";
    } catch (e) { 
        return "❌ Ocurrió un error al conectar con los servidores de búsqueda."; 
    }
}

// --- 5. NÚCLEO CENTRAL DE CONEXIÓN ---
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
            const statusCode = lastDisconnect.error?.output?.statusCode;
            if (statusCode === 405) process.exit(1);
            startBot();
        } else if (connection === 'open') {
            console.log('\n🚀 [SISTEMA] ¡BOT ONLINE Y LISTO EN TU GRUPO! 🚀\n');
        }
    });

    // --- 6. PROCESAMIENTO DE COMANDOS ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const chatId = msg.key.remoteJid;
        if (chatId !== GRUPO_PERMITIDO) return; // Candado estricto de grupo

        // Extraer credenciales limpias del bot e identificar si sos el Admin
        const miNumeroLimpio = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '5491128394646@s.whatsapp.net';
        const sender = msg.key.participant || (msg.key.fromMe ? miNumeroLimpio : msg.key.remoteJid); 
        const esAdmin = msg.key.fromMe || sender.includes('1128394646') || sender === miNumeroLimpio; 

        // Captura de texto general
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption;
        if (!text || !text.startsWith('/')) return;

        const args = text.slice(1).split(/ +/);
        const command = args.shift().toLowerCase();
        const query = args.join(' ');

        // Datos del mensaje citado (para ban/unban)
        const citado = msg.message.extendedTextMessage?.contextInfo;
        const usuarioCitado = citado?.participant;

        // Log en tiempo real en la consola de Render
        console.log(`[COMANDO] /${command} | Por: ${sender} | ¿Es Creador?: ${esAdmin}`);

        // 🔒 SECCIÓN CONTROLES DE EXPULSIÓN Y ADMINISTRACIÓN (Solo Dueño)
        if (['on', 'off', 'restart', 'restard', '+18on', '+18off', 'ban', 'unban'].includes(command)) {
            if (!esAdmin) return await sock.sendMessage(chatId, { text: '❌ No tenés autorización. Solo mi creador manda acá.' });

            switch(command) {
                case 'on':
                    botActivo = true;
                    return await sock.sendMessage(chatId, { text: '🟢 *Bot Encendido.* Comandos habilitados.' });
                
                case 'off':
                    botActivo = false;
                    return await sock.sendMessage(chatId, { text: '🔴 *Bot Apagado.* Ignoraré las búsquedas generales.' });
                
                case 'restart':
                case 'restard':
                    await sock.sendMessage(chatId, { text: '🔄 *Reiniciando instancias...* Vuelvo en un toque.' });
                    setTimeout(() => process.exit(0), 1000);
                    return;
                
                case '+18on':
                    nsfwPermitido = true;
                    return await sock.sendMessage(chatId, { text: '🔞 *Modo +18 Activado.* Filtros de Reddit removidos.' });
                
                case '+18off':
                    nsfwPermitido = false;
                    return await sock.sendMessage(chatId, { text: '🛡️ *Modo +18 Desactivado.* Contenido adulto bloqueado.' });

                case 'ban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Respondé al mensaje de la persona que quieras banear del bot.' });
                    if (usuarioCitado.includes('1128394646') || usuarioCitado === miNumeroLimpio) {
                        return await sock.sendMessage(chatId, { text: '❌ No podés banearte a vos mismo ni al bot.' });
                    }
                    if (!baneados.includes(usuarioCitado)) {
                        baneados.push(usuarioCitado);
                        guardarBaneos();
                    }
                    return await sock.sendMessage(chatId, { text: `🔨 *Usuario añadido a la Lista Negra.* El bot ignorará sus comandos.` });

                case 'unban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Respondé a un mensaje del usuario para perdonarlo.' });
                    baneados = baneados.filter(u => u !== usuarioCitado);
                    guardarBaneos();
                    return await sock.sendMessage(chatId, { text: '✅ *Usuario perdonado.* Puede volver a usar las funciones del bot.' });
            }
        }

        // Si el bot fue apagado mediante /off, frena las búsquedas generales acá
        if (!botActivo) return;

        // 🛡️ FILTRO DE LISTA NEGRA: Si está en la lista y no es admin, se lo ignora olímpicamente
        if (baneados.includes(sender) && !esAdmin) {
            console.log(`[SEGURIDAD] Intento de comando bloqueado para el usuario baneado: ${sender}`);
            return;
        }

        // 🌍 SECCIÓN COMANDOS DE BÚSQUEDA GENERAL
        switch (command) {
            case 'google':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ ¿Qué querés buscar? Ejemplo: `/google Física cuántica`' });
                const resGoogle = await searchGoogle(query);
                await sock.sendMessage(chatId, { text: resGoogle });
                break;

            case 'reddit':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/reddit shitposts`' });
                const resReddit = await searchReddit(query, nsfwPermitido);
                if (resReddit) {
                    await sock.sendMessage(chatId, { image: { url: resReddit.url }, caption: `🤖 *Reddit:* ${resReddit.title}` });
                } else {
                    await sock.sendMessage(chatId, { text: nsfwPermitido ? '❌ No encontré imágenes.' : '❌ Filtro +18 activo o sin resultados.' });
                }
                break;

            case 'pin':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/pin cyberpunk aesthetic`' });
                const imgPin = await searchPinterest(query);
                if (imgPin) {
                    await sock.sendMessage(chatId, { image: { url: imgPin }, caption: `📌 *Pinterest:* Resultado para "${query}"` });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ No encontré imágenes en Pinterest.' });
                }
                break;
        }
    });
}

startBot();
