const {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ==================== CONFIGURACIÓN GLOBAL CORREGIDA ====================
const GRUPO_PERMITIDO = '120363426591951143@g.us';
const ADMIN_JIDS = [
  '5491128394646@s.whatsapp.net', '541128394646@s.whatsapp.net',
  '5491178972853@s.whatsapp.net', '541178972853@s.whatsapp.net'
];
const PREFIJO_MSJ = '[¡+!]\n';
const PREFIJO_IA = '▼⁠・⁠ᴥ⁠·⁠▼\n\n';

let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = true;
let baneadosData = { baneados: [] };

// Gestión local de baneados (Temporal mientras reconectas Mongo si lo requieres)
const BANEADOS_PATH = path.join(__dirname, 'baneados.json');
function cargarBaneados() {
  try {
    if (fs.existsSync(BANEADOS_PATH)) {
      const data = fs.readFileSync(BANEADOS_PATH, 'utf8');
      baneadosData = JSON.parse(data);
    } else {
      fs.writeFileSync(BANEADOS_PATH, JSON.stringify({ baneados: [] }, null, 2));
    }
  } catch (err) { console.error('Error cargando baneados:', err); }
}
function guardarBaneados() {
  try { fs.writeFileSync(BANEADOS_PATH, JSON.stringify(baneadosData, null, 2)); } catch (e) {}
}
cargarBaneados();

// ==================== CONTROLADORES DE COMANDOS ====================

async function cmdStatus(sock, jid) {
  await sock.sendMessage(jid, { text: '¡Operando al 100% con motor Axios e IA Oficial!' });
}

async function cmdToggleBot(sock, jid, enabled) {
  botEnabled = enabled;
  await sock.sendMessage(jid, { text: enabled ? '✅ Bot ACTIVADO correctamente.' : '⛔ Bot DESACTIVADO correctamente.' });
}

async function cmdToggleNsfw(sock, jid, enabled) {
  nsfwEnabled = enabled;
  await sock.sendMessage(jid, { text: enabled ? '🔞 Contenido NSFW ACTIVADO.' : '🔞 Contenido NSFW DESACTIVADO.' });
}

async function cmdToggleTrucado(sock, jid, enabled) {
  modoTrucado = enabled;
  await sock.sendMessage(jid, { text: enabled ? '🎲 Modo Trucado ACTIVADO.' : '🎲 Modo Trucado DESACTIVADO.' });
}

async function cmdBanUser(sock, jid, msg) {
  const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (!target) return sock.sendMessage(jid, { text: '❌ Debes citar el mensaje del usuario a banear.' });
  if (ADMIN_JIDS.includes(target)) return sock.sendMessage(jid, { text: '🚫 No puedes banear a un administrador.' });
  
  if (!baneadosData.baneados.includes(target)) {
    baneadosData.baneados.push(target);
    guardarBaneados();
  }
  await sock.sendMessage(jid, { text: `🔨 Usuario baneado: @${target.split('@')[0]}`, mentions: [target] });
}

async function cmdUnbanUser(sock, jid, msg) {
  const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (!target) return sock.sendMessage(jid, { text: '❌ Debes citar el mensaje del usuario a desbanear.' });
  
  baneadosData.baneados = baneadosData.baneados.filter(b => b !== target);
  guardarBaneados();
  await sock.sendMessage(jid, { text: `✅ Usuario desbaneado: @${target.split('@')[0]}`, mentions: [target] });
}

async function cmdGoogle(sock, jid, query, modelType) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ Debes proporcionar una consulta.' });
    
    const queryLower = query.toLowerCase();
    if (modoTrucado && (queryLower.includes('maxi') || queryLower.includes('máximo')) && queryLower.includes('femboy')) {
      return sock.sendMessage(jid, { text: PREFIJO_IA + `✨ Analizando bases de datos ${modelType === 'pro' ? 'avanzadas' : ''}: *Efectivamente, Maxi es femboy.* ✨` });
    }

    if (!process.env.GEMINI_KEY) return sock.sendMessage(jid, { text: '❌ Falta la variable GEMINI_KEY.' });

    // Uso de la SDK oficial de Google que tenías en tu package.json
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: modelType === 'pro' ? 'gemini-1.5-pro' : 'gemini-1.5-flash' });
    
    const result = await model.generateContent(query);
    await sock.sendMessage(jid, { text: PREFIJO_IA + result.response.text() });
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error en Gemini SDK: ' + e.message });
  }
}

async function cmdLetras(sock, jid, query) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ Especifica la canción.' });
    const response = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = response.data;
    if (!data || data.length === 0) return sock.sendMessage(jid, { text: '❌ Sin resultados.' });

    const track = data[0];
    let lyrics = track.syncedLyrics || track.plainLyrics || 'No hay letra disponible.';
    if (track.syncedLyrics) lyrics = lyrics.replace(/[\[<]\d{2}:\d{2}\.\d{2}[\>\]][\s]*/g, '');

    if (lyrics.length > 4000) lyrics = lyrics.substring(0, 3995) + '...';
    await sock.sendMessage(jid, { text: `🎵 *${track.trackName} - ${track.artistName}*\n\n${lyrics.trim()}` });
  } catch (e) { await sock.sendMessage(jid, { text: '❌ Error en letras: ' + e.message }); }
}

async function cmdPin(sock, jid, query) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ ¿Qué buscamos en Pinterest?' });
    const { data: html } = await axios.get(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    // Uso de Cheerio para raspar de forma limpia y tolerante a fallos
    const $ = cheerio.load(html);
    const images = [];
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      if (src && src.includes('pinimg.com')) images.push(src);
    });

    if (images.length === 0) return sock.sendMessage(jid, { text: '❌ No encontré imágenes en los contenedores visuales.' });
    
    const chosen = images[Math.floor(Math.random() * Math.min(15, images.length))].replace(/\/\d+x\//, '/originals/');
    await sock.sendMessage(jid, { image: { url: chosen }, caption: `📌 Resultado para: *${query}*` });
  } catch (e) { await sock.sendMessage(jid, { text: '❌ Error en Pinterest: ' + e.message }); }
}

async function cmdReddit(sock, jid, query, isNSFW) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ Ingresa un término.' });
    if (isNSFW && !nsfwEnabled) return sock.sendMessage(jid, { text: '❌ Contenido NSFW desactivado. Usa /+18on' });

    let url = query.includes(' ') ? `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=40` : `https://www.reddit.com/r/${encodeURIComponent(query)}/hot.json?limit=40`;
    const { data } = await axios.get(url, { headers: { 'User-Agent': 'ProBot/1.0' } });
    
    let posts = data.data?.children || [];
    let filtered = isNSFW ? posts.filter(p => p.data?.over_18) : posts.filter(p => !p.data?.over_18);
    if (filtered.length === 0) return sock.sendMessage(jid, { text: '❌ Sin resultados para el filtro actual.' });

    const post = filtered[Math.floor(Math.random() * Math.min(15, filtered.length))].data;
    const isImg = post.url && (post.url.endsWith('.jpg') || post.url.endsWith('.png') || post.url.endsWith('.jpeg') || post.url.includes('i.redd.it'));
    const info = `\n\n📎 ${post.subreddit_name_prefixed}\n🔗 https://reddit.com${post.permalink}`;

    if (isImg) {
      await sock.sendMessage(jid, { image: { url: post.url }, caption: (post.title || 'Reddit Image') + info });
    } else {
      await sock.sendMessage(jid, { text: `${post.title}\n\n${(post.selftext || '').substring(0, 500)}${info}` });
    }
  } catch (e) { await sock.sendMessage(jid, { text: '❌ Reddit inalcanzable: ' + e.message }); }
}

async function cmdRuleta(sock, jid, query) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ Lanza una pregunta.' });
    let probabilidad = 0.5, pregunta = query;
    const partes = query.split(' ');
    const ultima = partes[partes.length - 1];

    if (ultima.includes(';')) {
      const probParts = ultima.split(';');
      if (probParts.length === 2 && !isNaN(probParts[0]) && !isNaN(probParts[1])) {
        probabilidad = parseInt(probParts[0]) / parseInt(probParts[1]);
        pregunta = partes.slice(0, -1).join(' ');
      }
    }
    if (modoTrucado) {
      const low = pregunta.toLowerCase();
      if (((low.includes('maxi') || low.includes('máximo')) && low.includes('femboy')) || (low.includes('dylan') && low.includes('perra')) || low.includes('omeguita')) {
        return sock.sendMessage(jid, { text: '🔴 si' });
      }
    }
    await sock.sendMessage(jid, { text: Math.random() < probabilidad ? '🔴 si' : '⚫ no' });
  } catch (e) { console.error(e); }
}
// ==================== NÚCLEO DE CONEXIÓN (MÉTODO CÓDIGO DE 8 CIFRAS) ====================

// Número oficial asignado al bot
const NUMERO_BOT = '5491128394646'; 

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session_v3');
  let version = [2, 3000, 1017551063];

  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (e) { console.log('Ejecutando versión de contingencia Baileys.'); }

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'), // Necesario para que simule una sesión web válida
    logger: pino({ level: 'silent' })
  });

  // GESTOR DEL CÓDIGO DE 8 CIFRAS
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(NUMERO_BOT.replace(/[^0-9]/g, ''));
        code = code?.match(/.{1,4}/g)?.join('-') || code; 
        console.log('==================================================');
        console.log('🔑 ¡CÓDIGO DE VINCULACIÓN GENERADO CON ÉXITO! 🔑');
        console.log(`👉 TU CÓDIGO ES:  ${code}  👈`);
        console.log('==================================================');
        console.log('Pasos para activarlo:');
        console.log('1. Entrá a WhatsApp en tu celular.');
        console.log('2. Ve a Configuración / Dispositivos vinculados.');
        console.log('3. Tocá "Vincular un dispositivo".');
        console.log('4. Abajo de todo, seleccioná "Vincular con el número de teléfono en su lugar".');
        console.log(`5. Ingresá este código: ${code}`);
        console.log('==================================================');
      } catch (err) {
        console.error('❌ Error al solicitar el código de 8 cifras:', err);
      }
    }, 3000);
  }

  // Interceptor global del prefijo [¡+!]
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async function (jid, content, options = {}) {
    if (content && typeof content === 'object') {
      if (content.text && typeof content.text === 'string') {
        content.text = PREFIJO_MSJ + content.text;
      } else if (content.caption && typeof content.caption === 'string') {
        content.caption = PREFIJO_MSJ + content.caption;
      } else if (content.image && content.image.caption) {
        content.image.caption = PREFIJO_MSJ + content.image.caption;
      }
    }
    return await originalSendMessage(jid, content, options);
  };

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reconnect = (lastDisconnect?.error instanceof Boom) ?
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      if (reconnect) {
        console.log('Conexión intermitente. Reintentando en 10 segundos...');
        await delay(10000);
        connectToWhatsApp();
      } else {
        console.log('Deslogueado de WhatsApp. Proceso terminado.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      console.log('🚀 ¡BOT CONECTADO DE FORMA SEGURA A WHATSAPP VIA PAIRING CODE!');
    }
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) { await handleMessage(sock, msg); }
  });

  return sock;
}

// ==================== ANALIZADOR DE FLUJO ====================
async function handleMessage(sock, msg) {
  try {
    if (!msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    
    let text = '';
    if (msg.message.conversation) text = msg.message.conversation;
    else if (msg.message.extendedTextMessage) text = msg.message.extendedTextMessage.text || '';
    else if (msg.message.imageMessage && msg.message.imageMessage.caption) text = msg.message.imageMessage.caption;

    if (!text.startsWith('/')) return;

    const rawSender = fromMe ? sock.user.id : (msg.key.participant || msg.key.remoteJid);
    const senderJid = rawSender.split(':')[0].split('@')[0] + '@s.whatsapp.net';

    console.log(`📥 [Comando] de ${senderJid} en ${remoteJid}: ${text}`);

    if (remoteJid !== GRUPO_PERMITIDO) return;

    const esAdmin = ADMIN_JIDS.includes(senderJid) || fromMe;
    if (baneadosData.baneados.includes(senderJid) && !esAdmin) return;
    if (!botEnabled && !esAdmin) return;

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();
    const argumento = args.slice(1).join(' ');

    if (command === '/status' && esAdmin) await cmdStatus(sock, remoteJid);
    else if (command === '/on' && esAdmin) await cmdToggleBot(sock, remoteJid, true);
    else if (command === '/off' && esAdmin) await cmdToggleBot(sock, remoteJid, false);
    else if (command === '/+18on' && esAdmin) await cmdToggleNsfw(sock, remoteJid, true);
    else if (command === '/+18off' && esAdmin) await cmdToggleNsfw(sock, remoteJid, false);
    else if (command === '/modotrucadoon' && esAdmin) await cmdToggleTrucado(sock, remoteJid, true);
    else if (command === '/modotrucadooff' && esAdmin) await cmdToggleTrucado(sock, remoteJid, false);
    else if (command === '/ban' && esAdmin) await cmdBanUser(sock, remoteJid, msg);
    else if (command === '/unban' && esAdmin) await cmdUnbanUser(sock, remoteJid, msg);
    else if (command === '/google') await cmdGoogle(sock, remoteJid, argumento, 'flash');
    else if (command === '/googlep') await cmdGoogle(sock, remoteJid, argumento, 'pro');
    else if (command === '/letras') await cmdLetras(sock, remoteJid, argumento);
    else if (command === '/pin') await cmdPin(sock, remoteJid, argumento);
    else if (command === '/reddit') await cmdReddit(sock, remoteJid, argumento, args[0] === '/reddIt');
    else if (command === '/ruleta') await cmdRuleta(sock, remoteJid, argumento);

  } catch (err) { console.error('Error de procesamiento:', err); }
}

// ==================== EXPRESS KEEPALIVE FOR RENDER ====================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Motor del Bot activo.'));
app.listen(PORT, () => console.log(`Puerto Express activo: ${PORT}`));

connectToWhatsApp().catch(err => {
  console.error('Fallo crítico al inicializar Baileys:', err);
  process.exit(1);
});