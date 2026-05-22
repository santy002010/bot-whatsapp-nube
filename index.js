const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

// --- 1. SERVIDOR EXPRESS (Para Render) ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Bot Privado Activo 🚀'));
app.listen(PORT, () => console.log(`[SERVER] Monitor activo en puerto ${PORT}`));

// --- 2. CONFIGURACIÓN DEL ADMIN Y GRUPO ---
// Tu número exacto como administrador absoluto
const ADMIN_JID = '5491128394646@s.whatsapp.net'; 
// REEMPLAZA ESTO con el ID real de tu grupo cuando te aparezca en la consola de Render
const GRUPO_PERMITIDO = '120363426591951143@g.us@g.us'; 

// Variables de estado del bot
let botActivo = true;       // Se controla con /on y /off
let nsfwPermitido = false;  // Se controla con /+18on y /+18off

// --- 3. MOTORES DE BÚSQUEDA DIRECTA (Imágenes y Textos) ---

// Buscar en Reddit (Extrae la imagen directa)
async function searchReddit(query, allowNsfw) {
    try {
        const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance`);
        const json = await res.json();
        const posts = json.data?.children || [];
        for (const post of posts) {
            const data = post.data;
            if (data.over_18 && !allowNsfw) continue; // Bloquea si +18 está apagado
            // Verifica que sea un enlace directo a una imagen
            if (data.url && data.url.match(/\.(jpeg|jpg|gif|png)$/i)) {
                return { url: data.url, title: data.title };
            }
        }
        return null;
    } catch (e) { return null; }
}

// Buscar en Pinterest (Extrae la imagen directa)
async function searchPinterest(query) {
    try {
        const res = await fetch(`https://ar.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`);
        const html = await res.text();
        const regex = /https:\/\/i\.pinimg\.com\/[^\s"'>]+\.(jpg|jpeg|png)/gi;
        const matches = html.match(regex);
        if (matches && matches.length > 0) {
            // Intenta buscar la de mejor calidad, si no, toma la primera
            const highRes = matches.filter(url => url.includes('originals') || url.includes('736x'));
            return highRes.length > 0 ? highRes[0] : matches[0];
        }
        return null;
    } catch (e) { return null; }
}

// Buscar en Google (Extrae información sin enlaces molestos)
async function searchGoogle(query) {
    try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const html = await res.text();
        const snippets = [...html.matchAll(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
        const titles = [...html.matchAll(/<h2 class="result__title">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
        
        if (titles.length === 0) return "❌ No encontré información sobre eso.";
        
        let result = `🔍 *RESULTADOS: ${query}*\n\n`;
        for(let i=0; i<Math.min(3, titles.length); i++) {
            result += `📌 *${titles[i]}*\n📝 ${snippets[i]}\n\n`;
        }
        return result.trim();
    } catch (e) { return "❌ Ocurrió un error buscando la información."; }
}

// --- 4. SISTEMA CENTRAL DEL BOT ---
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

    // Pide código de vinculación si la sesión no existe
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode('5491128394646');
                console.log('\n==================================================');
                console.log(`🔑 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log('==================================================\n');
            } catch (error) { console.error('[ERROR] No se pudo pedir el código:', error.message); }
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
            console.log('\n🚀 ¡BOT VINCULADO Y LISTO! 🚀\n');
        }
    });

    // --- 5. RECEPCIÓN Y LECTURA DE MENSAJES ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid; 
        const esAdmin = sender === ADMIN_JID;

        // 🛡️ BARRERA 1: Solo permitir mensajes de tu grupo específico
        if (chatId !== GRUPO_PERMITIDO) {
            // Este log te ayudará a ver tu ID de grupo en Render la primera vez
            if (chatId.endsWith('@g.us')) {
                console.log(`[INFO] Mensaje en grupo ignorado. ID del grupo: ${chatId}`);
            }
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text || !text.startsWith('/')) return;

        const args = text.slice(1).split(/ +/);
        const command = args.shift().toLowerCase();
        const query = args.join(' ');

        // --- COMANDOS EXCLUSIVOS PARA TI (ADMIN) ---
        if (['on', 'off', 'restart', 'restard', '+18on', '+18off'].includes(command)) {
            if (!esAdmin) return await sock.sendMessage(chatId, { text: '❌ Solo mi creador (Admin) puede usar este comando.' });

            switch(command) {
                case 'on':
                    botActivo = true;
                    return await sock.sendMessage(chatId, { text: '🟢 *Bot Encendido:* Listo para ayudar.' });
                case 'off':
                    botActivo = false;
                    return await sock.sendMessage(chatId, { text: '🔴 *Bot Apagado:* Ignoraré todo hasta que mi Admin escriba /on.' });
                case 'restart':
                case 'restard':
                    await sock.sendMessage(chatId, { text: '🔄 *Reiniciando los servidores...* Vuelvo enseguida.' });
                    setTimeout(() => process.exit(0), 1000);
                    return;
                case '+18on':
                    nsfwPermitido = true;
                    return await sock.sendMessage(chatId, { text: '🔞 *Modo +18 Activado:* Filtros de seguridad deshabilitados.' });
                case '+18off':
                    nsfwPermitido = false;
                    return await sock.sendMessage(chatId, { text: '🛡️ *Modo +18 Desactivado:* Contenido adulto bloqueado.' });
            }
        }

        // 🛡️ BARRERA 2: Si el bot está apagado, no hace nada
        if (!botActivo) return;

        // --- COMANDOS DE BÚSQUEDA (Para todos en el grupo) ---
        switch (command) {
            case 'google':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Debes escribir qué quieres buscar. Ejemplo: `/google dinosaurios`' });
                const resGoogle = await searchGoogle(query);
                await sock.sendMessage(chatId, { text: resGoogle });
                break;

            case 'reddit':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/reddit gatos`' });
                await sock.sendMessage(chatId, { text: '⏳ Buscando imagen en Reddit...' });
                const resReddit = await searchReddit(query, nsfwPermitido);
                if (resReddit) {
                    // Envía la imagen DIRECTAMENTE, no el enlace
                    await sock.sendMessage(chatId, { image: { url: resReddit.url }, caption: `🤖 *Reddit:* ${resReddit.title}` });
                } else {
                    await sock.sendMessage(chatId, { text: nsfwPermitido ? '❌ No encontré imágenes.' : '❌ No hay imágenes o fueron bloqueadas por el filtro +18.' });
                }
                break;

            case 'pin':
                if (!query) return await sock.sendMessage(chatId, { text: '⚠️ Ejemplo: `/pin paisajes`' });
                await sock.sendMessage(chatId, { text: '⏳ Buscando imagen en Pinterest...' });
                const imgPin = await searchPinterest(query);
                if (imgPin) {
                    // Envía la imagen DIRECTAMENTE, no el enlace
                    await sock.sendMessage(chatId, { image: { url: imgPin }, caption: `📌 *Pinterest:* Resultado para "${query}"` });
                } else {
                    await sock.sendMessage(chatId, { text: '❌ No se encontraron imágenes en Pinterest para esa búsqueda.' });
                }
                break;
        }
    });
}

startBot();
