const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');

// --- 1. SERVIDOR DE MONITOREO (Para mantener vivo el bot en Render) ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot Privado Pro Activo v3 🚀'));
app.listen(PORT, () => console.log(`[SERVER] Monitor activo en puerto ${PORT}`));

// --- 2. CONFIGURACIÓN DE SEGURIDAD ---
const GRUPO_PERMITIDO = '120363426591951143@g.us'; 

let botActivo = true;       
let nsfwPermitido = false;  

// --- 3. SISTEMA DE BANEOS (Persistente) ---
const banFile = './auth_session/baneados.json';
let baneados = [];
try { 
    if (fs.existsSync(banFile)) {
        const fileContent = fs.readFileSync(banFile, 'utf-8');
        baneados = fileContent ? JSON.parse(fileContent) : [];
    }
} catch(e) { console.log('[SISTEMA] Inicializando base de datos de baneos.'); }

function guardarBaneos() {
    try { 
        if (!fs.existsSync('./auth_session')) fs.mkdirSync('./auth_session');
        fs.writeFileSync(banFile, JSON.stringify(baneados, null, 2)); 
    } catch(e) { console.error('[ERROR] Lista negra no guardada:', e.message); }
}

// --- 4. MOTORES DE BÚSQUEDA PROFESIONALES ---

// Reddit Pro
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

// Pinterest Pro (Conexión vía API de Recursos Interna para Evitar Bloqueos)
async function searchPinterest(query) {
    try {
        const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?data=${encodeURIComponent(JSON.stringify({ options: { query: query, scope: 'pins', page_size: 5 }, context: {} }))}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });
        const json = await res.json();
        const results = json.resource_response?.data?.results || [];
        if (results.length > 0) {
            return results[0].images?.orig?.url || results[0].images?.['736x']?.url || null;
        }
        return null;
    } catch (e) { 
        return null; 
    }
}

// Google Pro (Scraper HTML Orgánico - Trae resultados reales y exactos de la Web)
async function searchGoogle(query) {
    try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const html = await res.text();
        
        // Extracción limpia de títulos y fragmentos descriptivos de la web
        const titles = [...html.matchAll(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
        const snippets = [...html.matchAll(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());

        if (titles.length === 0) return "❌ No encontré resultados exactos en la web para esa búsqueda.";

        let responseText = `🔍 *Resultados de Búsqueda:* _${query}_\n\n`;
        const maxResults = Math.min(titles.length, 3); // Enviamos los 3 mejores resultados reales
        
        for(let i = 0; i < maxResults; i++) {
            responseText += `🔹 *${titles[i]}*\n📝 ${snippets[i] || 'Sin descripción disponible.'}\n\n`;
        }
        return responseText.trim();
    } catch (e) {
        return "❌ Error de conexión al procesar los motores de búsqueda.";
    }
}

// --- 5. NÚCLEO CENTRAL ---
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
                console.log(`🔑 CÓDIGO DE VINCULACIÓN: ${code}`);
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
            console.log('\n🚀 [SISTEMA] ¡BOT REDISEÑADO ONLINE! 🚀\n');
        }
    });

    // --- 6. PROCESAMIENTO DE COMANDOS ---
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

        console.log(`[EJECUCIÓN] /${command} por ${sender}`);

        // 🔒 SECCIÓN ADMINISTRACIÓN (Solo Dueño)
        if (['on', 'off', 'restart', 'restard', '+18on', '+18off', 'ban', 'unban'].includes(command)) {
            if (!esAdmin) return await sock.sendMessage(chatId, { text: '❌ No tenés autorización. Solo mi creador manda acá.' });

            switch(command) {
                case 'on':
                    botActivo = true;
                    return await sock.sendMessage(chatId, { text: '🟢 *Bot Encendido.* Comandos habilitados.' });
                case 'off':
                    botActivo = false;
                    return await sock.sendMessage(chatId, { text: '🔴 *Bot Apagado.* Búsquedas deshabilitadas.' });
                case 'restart':
                case 'restard':
                    await sock.sendMessage(chatId, { text: '🔄 *Reiniciando instancias...* Espérame un minuto.' });
                    setTimeout(() => process.exit(0), 1000);
                    return;
                case '+18on':
                    nsfwPermitido = true;
                    return await sock.sendMessage(chatId, { text: '🔞 *Modo +18 Activado.*' });
                case '+18off':
                    nsfwPermitido = false;
                    return await sock.sendMessage(chatId, { text: '🛡️ *Modo +18 Desactivado.*' });
                case 'ban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Respondé al mensaje de la persona que quieras banear.' });
                    if (usuarioCitado.includes('1128394646') || usuarioCitado === miNumeroLimpio) {
                        return await sock.sendMessage(chatId, { text: '❌ No podés banearte a vos mismo ni al bot.' });
                    }
                    if (!baneados.includes(usuarioCitado)) {
                        baneados.push(usuarioCitado);
                        guardarBaneos();
                    }
                    return await sock.sendMessage(chatId, { text: `🔨 *Usuario añadido a la Lista Negra.*` });
                case 'unban':
                    if (!usuarioCitado) return await sock.sendMessage(chatId, { text: '⚠️ Respondé a un mensaje del usuario para perdonarlo.' });
                    baneados = baneados.filter(u => u !== usuarioCitado);
                    guardarBaneos();
                    return await sock.sendMessage(chatId, { text: '✅ *Usuario perdonado.*' });
            }
        }

        if (!botActivo) return;

        // 🛡️ FILTRO DE LISTA NEGRA CON AVISO DIRECTO AL USUARIO
        if (baneados.includes(sender) && !esAdmin) {
            console.log(`[BLOQUEADO] Intento de comando rechazado para: ${sender}`);
            return await sock.sendMessage(chatId, { text: '❌ *Acceso Denegado:* Fuiste bloqueado por el administrador y no podés usar los comandos de este bot.' });
        }

        // 🌍 SECCIÓN COMANDOS GENERALES
        switch (command) {
            case 'google':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ ¿Qué querés buscar? Ejemplo: `/google Final de la Champions`' });
                const resGoogle = await searchGoogle(query);
                await sock.sendMessage(chatId, { text: resGoogle });
                break;

            case 'reddit':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/reddit memes`' });
                const resReddit = await searchReddit(query, nsfwPermitido);
                if (resReddit) {
                    await sock.sendMessage(chatId, { image: { url: resReddit.url }, caption: `🤖 *Reddit:* ${resReddit.title}` });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ Sin resultados o filtro +18 activo.' });
                }
                break;

            case 'pin':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/pin anime aesthetic`' });
                const imgPin = await searchPinterest(query);
                if (imgPin) {
                    await sock.sendMessage(chatId, { image: { url: imgPin }, caption: `📌 *Pinterest:* Resultado para "${query}"` });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ No se encontraron imágenes en Pinterest para esa búsqueda.' });
                }
                break;
        }
    });
}

startBot();
