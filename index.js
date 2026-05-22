const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.status(200).send('<h1>Bot WhatsApp Pro Online</h1>'));
app.listen(PORT, () => console.log(`[SERVER] Puerto ${PORT} activo`));

const GRUPO_PERMITIDO = '120363426591951143@g.us';
const ADMINS = ['5491128394646', '5491178972853'];

let botActivo = true;
let nsfwPermitido = false;

const banFile = './auth_session/baneados.json';
let baneados = [];
try { if (fs.existsSync(banFile)) baneados = JSON.parse(fs.readFileSync(banFile, 'utf-8')); } catch(e) {}

function guardarBaneos() { fs.writeFileSync(banFile, JSON.stringify(baneados, null, 2)); }

async function searchReddit(query, allowNsfw) {
    try {
        const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        const posts = json.data?.children || [];
        for (const post of posts) {
            if (post.data.over_18 && !allowNsfw) continue;
            if (post.data.url?.match(/\.(jpeg|jpg|gif|png)$/i)) return { url: post.data.url, title: post.data.title };
        }
        return null;
    } catch (e) { return null; }
}

async function searchPinterest(query) {
    try {
        const res = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }});
        const html = await res.text();
        const matches = [...html.matchAll(/(https:\/\/[^"'\s&<>]+\.(?:jpg|jpeg|png))/gi)];
        return matches.length > 0 ? matches[0][1] : null;
    } catch (e) { return null; }
}

async function searchGoogle(query) {
    try {
        const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
        const json = await res.json();
        return json.extract ? `🔍 *${query}*\n\n${json.extract}` : "❌ No encontré resultados.";
    } catch(e) { return "❌ Error de conexión."; }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ["Ubuntu", "Chrome", "20.0.04"] });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode('5491178972853');
                console.log(`\n🔑 CÓDIGO DE VINCULACIÓN: ${code}\n`);
            } catch (e) { }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'close') {
            const tiempo = sock.authState.creds.registered ? 10000 : 300000;
            console.log(`\n[ALERTA] Desconectado. Reconectando en ${tiempo/1000}s...`);
            setTimeout(startBot, tiempo);
        } else if (connection === 'open') {
            console.log('\n🚀 [SISTEMA] ¡BOT ONLINE! 🚀\n');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid !== GRUPO_PERMITIDO) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const esAdmin = msg.key.fromMe || ADMINS.some(a => sender.includes(a));
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (!text.startsWith('/')) return;

        const [command, ...args] = text.slice(1).split(' ');
        const query = args.join(' ');

        // COMANDO STATUS
        if (command.toLowerCase() === 'status') {
            return await sock.sendMessage(msg.key.remoteJid, { text: "✅ ¡Hola! Estoy vivo y conectado a WhatsApp, funciono perfectamente." });
        }

        if (['on', 'off', 'ban', 'unban', '+18on', '+18off'].includes(command.toLowerCase())) {
            if (!esAdmin) return;
            switch(command.toLowerCase()) {
                case 'on': botActivo = true; return await sock.sendMessage(msg.key.remoteJid, { text: '🟢 Encendido.' });
                case 'off': botActivo = false; return await sock.sendMessage(msg.key.remoteJid, { text: '🔴 Apagado.' });
                case '+18on': nsfwPermitido = true; return await sock.sendMessage(msg.key.remoteJid, { text: '🔞 +18 ON' });
                case '+18off': nsfwPermitido = false; return await sock.sendMessage(msg.key.remoteJid, { text: '🛡️ +18 OFF' });
                case 'ban': 
                    const user = msg.message.extendedTextMessage?.contextInfo?.participant;
                    if(user && !baneados.includes(user)) { baneados.push(user); guardarBaneos(); await sock.sendMessage(msg.key.remoteJid, { text: '🔨 Usuario baneado.' }); }
                    break;
                case 'unban':
                    const userU = msg.message.extendedTextMessage?.contextInfo?.participant;
                    baneados = baneados.filter(u => u !== userU); guardarBaneos(); await sock.sendMessage(msg.key.remoteJid, { text: '✅ Usuario perdonado.' });
                    break;
            }
        }

        if (!botActivo || baneados.includes(sender)) return;

        if (command.toLowerCase() === 'google') {
            const res = await searchGoogle(query);
            await sock.sendMessage(msg.key.remoteJid, { text: res });
        } else if (command.toLowerCase() === 'reddit') {
            const res = await searchReddit(query, nsfwPermitido);
            if (res) await sock.sendMessage(msg.key.remoteJid, { image: { url: res.url }, caption: res.title });
        } else if (command.toLowerCase() === 'pin') {
            const res = await searchPinterest(query);
            if (res) await sock.sendMessage(msg.key.remoteJid, { image: { url: res }, caption: query });
        }
    });
}

startBot();
