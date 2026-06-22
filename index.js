// ==================== CONFIGURACIÓN E IMPORTACIONES ====================
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  delay,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

// Variables Globales de Control
const PREFIJO_MSJ = '[¡+!] '; 
const NUMERO_BOT = '5491128394646'; // Tu número de celular oficial del bot
const GRUPO_PERMITIDO = '120363294615367351@g.us'; // ID de tu grupo
const ADMIN_JIDS = ['5491128394646@s.whatsapp.net']; // Tu JID como administrador

let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = false;
let baneadosData = { baneados: [] };

// ==================== NÚCLEO DE CONEXIÓN (CON DISCO PERSISTENTE) ====================
async function connectToWhatsApp() {
  // CORRECCIÓN: Volvemos a usar 'baileys_auth_info' para enlazar con tu disco de Render
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  let version = [2, 3000, 1017551063];

  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (e) { 
    console.log('Ejecutando versión de contingencia Baileys.'); 
  }

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' })
  });

  // Solo generará código si por alguna razón el disco de Render estuviera vacío
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(NUMERO_BOT.replace(/[^0-9]/g, ''));
        code = code?.match(/.{1,4}/g)?.join('-') || code; 
        console.log('==================================================');
        console.log('🔑 ¡CÓDIGO DE VINCULACIÓN GENERADO CON ÉXITO! 🔑');
        console.log(`👉 TU CÓDIGO ES:  ${code}  👈`);
        console.log('==================================================');
      } catch (err) {
        console.error('❌ Error al solicitar el código de 8 cifras:', err);
      }
    }, 4000);
  }

  // Interceptor global del prefijo [¡+!] para tus mensajes de salida
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async function (jid, content, options = {}) {
    if (content && typeof content === 'object') {
      if (content.text && typeof content.text === 'string') content.text = PREFIJO_MSJ + content.text;
      else if (content.caption && typeof content.caption === 'string') content.caption = PREFIJO_MSJ + content.caption;
      else if (content.image && content.image.caption) content.image.caption = PREFIJO_MSJ + content.image.caption;
    }
    return await originalSendMessage(jid, content, options);
  };

  // Manejo inteligente de la reconexión activa
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const reconnect = (lastDisconnect?.error instanceof Boom) ?
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      if (reconnect) {
        console.log('Conexión perdida. Reconectando en 10 segundos...');
        setTimeout(connectToWhatsApp, 10000);
      } else {
        process.exit(0);
      }
    } else if (connection === 'open') {
      console.log('🚀 ¡BOT CONECTADO DE FORMA SEGURA A WHATSAPP!');
    }
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) { await handleMessage(sock, msg); }
  });

  return sock;
}

// ==================== CONTROLADORES DE COMANDOS REALES ====================

async function cmdStatus(sock, jid) {
  await sock.sendMessage(jid, { text: '¡Bot activo y operando al 100%! 🚀' });
}

async function cmdTest(sock, jid) {
  await sock.sendMessage(jid, { text: '🧪 *Iniciando test estructural de comandos...*' });
  let reporte = '📊 *REPORTE DE DIAGNÓSTICO EN VIVO* 📊\n\n';
  reporte += '🟢 */status:* Operativo\n';
  reporte += '🟢 */ruleta:* Operativo\n';
  
  try {
    const apiKey = process.env.GEMINI_KEY;
    if (!apiKey) throw new Error('Falta la variable de entorno GEMINI_KEY');
    await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      contents: [{ parts: [{ text: 'Ping' }] }]
    }, { timeout: 4000 });
    reporte += '🟢 */google (Gemini API):* Operativo\n';
  } catch (e) {
    reporte += `🔴 */google (Gemini API):* Error -> ${e.message}\n`;
  }
  
  try {
    await axios.get('https://lrclib.net/api/search?q=test', { timeout: 4000 });
    reporte += '🟢 */letras (LRCLIB API):* Operativo\n';
  } catch (e) {
    reporte += `🔴 */letras (LRCLIB API):* Error -> ${e.message}\n`;
  }
  
  try {
    await axios.get('https://www.pinterest.com', { timeout: 4000 });
    reporte += '🟢 */pin (Pinterest Web):* Conectado\n';
  } catch (e) {
    reporte += `🔴 */pin (Pinterest Web):* Error de red\n`;
  }
  
  try {
    await axios.get('https://www.reddit.com/.json', { headers: { 'User-Agent': 'ProBot/1.0' }, timeout: 4000 });
    reporte += '🟢 */reddit (Reddit Web):* Conectado\n';
  } catch (e) {
    reporte += `🔴 */reddit (Reddit Web):* Error de red\n`;
  }
  
  await sock.sendMessage(jid, { text: reporte });
}

async function cmdGoogle(sock, jid, query, mode) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ Introduce una consulta o pregunta.' });
    const apiKey = process.env.GEMINI_KEY;
    if (!apiKey) return sock.sendMessage(jid, { text: '❌ Falta configurar la variable GEMINI_KEY en Render.' });

    const model = mode === 'pro' ? 'gemini-1.5-pro' : 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: query }] }]
    }, { timeout: 12000 });

    const respuestaTexto = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No obtuve respuesta del motor de IA.';
    await sock.sendMessage(jid, { text: respuestaTexto });
  } catch (e) {
    await sock.sendMessage(jid, { text: '🔴 Error en IA Google: ' + (e.response?.data?.error?.message || e.message) });
  }
}

async function cmdLetras(sock, jid, query) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ Especificá la canción.' });
    const response = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });
    const data = response.data;
    if (!data || data.length === 0) return sock.sendMessage(jid, { text: '❌ Sin resultados para esa canción.' });

    const track = data[0];
    let lyrics = track.syncedLyrics || track.plainLyrics || 'No hay letra disponible registrada.';
    if (track.syncedLyrics) lyrics = lyrics.replace(/[\[<]\d{2}:\d{2}\.\d{2}[\>\]][\s]*/g, '');

    if (lyrics.length > 4000) lyrics = lyrics.substring(0, 3995) + '...';
    await sock.sendMessage(jid, { text: `🎵 *${track.trackName} - ${track.artistName}*\n\n${lyrics.trim()}` });
  } catch (e) {
    await sock.sendMessage(jid, { text: '⏳ El servidor de letras está saturado. Volvé a intentar el comando ahora.' });
  }
}

async function cmdPin(sock, jid, query) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ ¿Qué querés buscar en Pinterest?' });
    const response = await axios.get(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 6000
    });
    const matches = response.data.match(/https:\/\/i\.pinimg\.com\/[^\s"'>]+/g) || [];
    if (matches.length === 0) return sock.sendMessage(jid, { text: '❌ No se encontraron imágenes para esa búsqueda.' });
    
    let imgUrl = matches[Math.floor(Math.random() * Math.min(matches.length, 10))].replace(/\\u002F/g, '/');
    await sock.sendMessage(jid, { image: { url: imgUrl }, caption: `🖼️ Pinterest: "${query}"` });
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error en Pinterest: ' + e.message });
  }
}

async function cmdReddit(sock, jid, query) {
  try {
    const subreddit = query?.trim() ? query.trim() : 'funny';
    const response = await axios.get(`https://www.reddit.com/r/${subreddit}/hot.json?limit=12`, {
      headers: { 'User-Agent': 'ProBot/1.0' },
      timeout: 6000
    });
    const posts = response.data?.data?.children || [];
    if (posts.length === 0) return sock.sendMessage(jid, { text: '❌ No se encontraron posts en r/' + subreddit });
    
    const filtroPosts = posts.filter(p => !p.data.over_18 || nsfwEnabled);
    if (filtroPosts.length === 0) return sock.sendMessage(jid, { text: '🔞 Contenido explícito bloqueado. Habilitá /+18on primero.' });
    
    const post = filtroPosts[Math.floor(Math.random() * filtroPosts.length)].data;
    const infoText = `🤖 *${post.title}*\n\nSubreddit: r/${post.subreddit}\n👍 Upvotes: ${post.ups}\n\n${post.selftext || post.url}`;
    
    if (post.url && (post.url.endsWith('.jpg') || post.url.endsWith('.png') || post.url.endsWith('.jpeg'))) {
      await sock.sendMessage(jid, { image: { url: post.url }, caption: infoText });
    } else {
      await sock.sendMessage(jid, { text: infoText });
    }
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error en Reddit: ' + e.message });
  }
}

async function cmdBanUser(sock, jid, msg) {
  try {
    const mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                    msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!mention) return sock.sendMessage(jid, { text: '❌ Responda al mensaje del usuario o menciónelo (@) para banear.' });
    const target = mention.split('@')[0] + '@s.whatsapp.net';
    if (!baneadosData.baneados.includes(target)) baneadosData.baneados.push(target);
    await sock.sendMessage(jid, { text: `🔨 El usuario @${target.split('@')[0]} fue suspendido del sistema del bot.`, mentions: [target] });
  } catch (e) { await sock.sendMessage(jid, { text: '❌ Error al ejecutar comando.' }); }
}

async function cmdUnbanUser(sock, jid, msg) {
  try {
    const mention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                    msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!mention) return sock.sendMessage(jid, { text: '❌ Responda al mensaje del usuario o menciónelo para remover el ban.' });
    const target = mention.split('@')[0] + '@s.whatsapp.net';
    baneadosData.baneados = baneadosData.baneados.filter(b => b !== target);
    await sock.sendMessage(jid, { text: `✅ El usuario @${target.split('@')[0]} fue readmitido en el sistema.`, mentions: [target] });
  } catch (e) { await sock.sendMessage(jid, { text: '❌ Error al ejecutar comando.' }); }
}

async function cmdToggleBot(sock, jid, state) { botEnabled = state; await sock.sendMessage(jid, { text: `Bot ${state ? 'ENCENDIDO 🟢' : 'APAGADO 🔴'}` }); }
async function cmdToggleNsfw(sock, jid, state) { nsfwEnabled = state; await sock.sendMessage(jid, { text: `Modo +18 ${state ? 'ACTIVADO 🔞' : 'DESACTIVADO 🛡️'}` }); }
async function cmdToggleTrucado(sock, jid, state) { modoTrucado = state; await sock.sendMessage(jid, { text: `Modo Trucado ${state ? 'ACTIVADO ⚡' : 'DESACTIVADO ❌'}` }); }
async function cmdRuleta(sock, jid) { const r = Math.random() > 0.5 ? '🔫 *¡PUM! Moriste.*' : '🔒 *Click... Te salvaste del disparo.*'; await sock.sendMessage(jid, { text: r }); }

// ==================== ANALIZADOR DE FLUJO (MENSAJES ENTRANTES) ====================
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

    // Habilitación de ejecución: Responderá en el grupo asignado O en cualquier chat privado
    const esChatPrivado = remoteJid.endsWith('@s.whatsapp.net');
    if (remoteJid !== GRUPO_PERMITIDO && !esChatPrivado) return;

    const esAdmin = ADMIN_JIDS.includes(senderJid) || fromMe;
    if (baneadosData.baneados.includes(senderJid) && !esAdmin) return;
    if (!botEnabled && !esAdmin) return;

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();
    const argumento = args.slice(1).join(' ');

    // Enrutador definitivo de comandos
    if (command === '/status' && esAdmin) await cmdStatus(sock, remoteJid);
    else if (command === '/test' && esAdmin) await cmdTest(sock, remoteJid); 
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
    else if (command === '/reddit') await cmdReddit(sock, remoteJid, argumento);
    else if (command === '/ruleta') await cmdRuleta(sock, remoteJid);

  } catch (err) { 
    console.error('Error de procesamiento en flujo principal:', err); 
  }
}

// ==================== EXPRESS KEEPALIVE FOR RENDER ====================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Servidor del bot de WhatsApp encendido correctamente.'));
app.listen(PORT, () => console.log(`Puerto Express activo: ${PORT}`));

connectToWhatsApp().catch(err => {
  console.error('Fallo crítico al inicializar Baileys:', err);
  process.exit(1);
});
