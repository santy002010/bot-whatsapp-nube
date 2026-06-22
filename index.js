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

// ==================== CONFIGURACIÓN GLOBAL ====================
const GRUPO_PERMITIDO = '120363426591951143@g.us';
const ADMIN_JIDS = ['5491128394646@s.whatsapp.net', '5491178972853@s.whatsapp.net'];
const PREFIJO_MSJ = '[¡+!]\n';
const PREFIJO_IA = '▼⁠・⁠ᴥ⁠·⁠▼\n\n';

// Estado global en memoria
let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = true;
let baneadosData = { baneados: [] };

// Cargar y Guardar baneados desde JSON
const BANEADOS_PATH = path.join(__dirname, 'baneados.json');
function cargarBaneados() {
  try {
    if (fs.existsSync(BANEADOS_PATH)) {
      const data = fs.readFileSync(BANEADOS_PATH, 'utf8');
      baneadosData = JSON.parse(data);
      if (!baneadosData.baneados) baneadosData = { baneados: [] };
    } else {
      baneadosData = { baneados: [] };
      guardarBaneados();
    }
  } catch (err) {
    console.error('Error al cargar baneados.json:', err);
    baneadosData = { baneados: [] };
  }
}

function guardarBaneados() {
  try {
    fs.writeFileSync(BANEADOS_PATH, JSON.stringify(baneadosData, null, 2));
  } catch (err) {
    console.error('Error al guardar baneados.json:', err);
  }
}

cargarBaneados();

// ==================== LÓGICA DE COMANDOS ====================

async function cmdStatus(sock, jid) {
  try {
    await sock.sendMessage(jid, { text: '¡Operando al 100%!' });
  } catch (e) { console.error('Error en status:', e); }
}

async function cmdToggleBot(sock, jid, enabled) {
  try {
    botEnabled = enabled;
    const msg = enabled ? '✅ Bot ACTIVADO correctamente.' : '⛔ Bot DESACTIVADO correctamente.';
    await sock.sendMessage(jid, { text: msg });
  } catch (e) { console.error('Error en toggleBot:', e); }
}

async function cmdToggleNsfw(sock, jid, enabled) {
  try {
    nsfwEnabled = enabled;
    const msg = enabled ? '🔞 Contenido NSFW ACTIVADO.' : '🔞 Contenido NSFW DESACTIVADO.';
    await sock.sendMessage(jid, { text: msg });
  } catch (e) { console.error('Error en toggleNsfw:', e); }
}

async function cmdToggleTrucado(sock, jid, enabled) {
  try {
    modoTrucado = enabled;
    const msg = enabled ? '🎲 Modo Trucado ACTIVADO.' : '🎲 Modo Trucado DESACTIVADO.';
    await sock.sendMessage(jid, { text: msg });
  } catch (e) { console.error('Error en toggleTrucado:', e); }
}

async function cmdBanUser(sock, jid, msg) {
  try {
    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!quotedParticipant) {
      await sock.sendMessage(jid, { text: '❌ Debes citar el mensaje del usuario que deseas banear.' });
      return;
    }
    if (ADMIN_JIDS.includes(quotedParticipant)) {
      await sock.sendMessage(jid, { text: '🚫 No puedes banear a un administrador.' });
      return;
    }
    if (!baneadosData.baneados.includes(quotedParticipant)) {
      baneadosData.baneados.push(quotedParticipant);
      guardarBaneados();
    }
    await sock.sendMessage(jid, { text: `🔨 Usuario baneado: @${quotedParticipant.split('@')[0]}`, mentions: [quotedParticipant] });
  } catch (e) { console.error('Error en banUser:', e); }
}

async function cmdUnbanUser(sock, jid, msg) {
  try {
    const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!quotedParticipant) {
      await sock.sendMessage(jid, { text: '❌ Debes citar el mensaje del usuario que deseas desbanear.' });
      return;
    }
    baneadosData.baneados = baneadosData.baneados.filter(b => b !== quotedParticipant);
    guardarBaneados();
    await sock.sendMessage(jid, { text: `✅ Usuario desbaneado: @${quotedParticipant.split('@')[0]}`, mentions: [quotedParticipant] });
  } catch (e) { console.error('Error en unbanUser:', e); }
}

async function cmdGoogle(sock, jid, query, modelType) {
  try {
    if (!query || query.trim().length === 0) {
      await sock.sendMessage(jid, { text: '❌ Debes proporcionar una consulta para Google Gemini.' });
      return;
    }
    const queryLower = query.toLowerCase();
    if (modoTrucado && (queryLower.includes('maxi') || queryLower.includes('máximo')) && queryLower.includes('femboy')) {
      const avanzadas = modelType === 'pro' ? 'avanzadas' : '';
      await sock.sendMessage(jid, { text: PREFIJO_IA + `✨ Analizando mis bases de datos ${avanzadas}: *Efectivamente, Maxi es femboy.* ✨` });
      return;
    }
    const apiKey = process.env.GEMINI_KEY;
    if (!apiKey) {
      await sock.sendMessage(jid, { text: '❌ Error: No se encontró la API KEY de Gemini.' });
      return;
    }
    const model = modelType === 'pro' ? 'gemini-1.5-pro' : 'gemini-1.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: query }] }] })
    });
    if (!response.ok) throw new Error(`Error API: ${response.status}`);
    const data = await response.json();
    const respuestaIA = data.candidates[0]?.content?.parts[0]?.text || 'No se obtuvo respuesta.';
    await sock.sendMessage(jid, { text: PREFIJO_IA + respuestaIA });
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error al consultar Gemini: ' + e.message });
  }
}

async function cmdLetras(sock, jid, query) {
  try {
    if (!query || query.trim().length === 0) {
      await sock.sendMessage(jid, { text: '❌ Debes especificar el nombre de la canción.' });
      return;
    }
    let trackName = query, artistName = '';
    if (query.includes('-')) {
      const parts = query.split('-').map(p => p.trim());
      trackName = parts[0];
      artistName = parts[1] || '';
    }
    const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!response.ok) throw new Error(`Error API: ${response.status}`);
    const data = await response.json();
    if (!data || data.length === 0) {
      await sock.sendMessage(jid, { text: '❌ No se encontraron letras para esa canción.' });
      return;
    }
    let selectedTrack = (artistName) 
      ? data.find(t => t.trackName?.toLowerCase() === trackName.toLowerCase() && t.artistName?.toLowerCase() === artistName.toLowerCase())
      : null;
    if (!selectedTrack) selectedTrack = data[0];
    let lyrics = selectedTrack.syncedLyrics || selectedTrack.plainLyrics || '';
    if (selectedTrack.syncedLyrics) {
      lyrics = lyrics.replace(/[\[<]\d{2}:\d{2}\.\d{2}[\>\]][\s]*/g, '').replace(/[\[<]\d{2}:\d{2}[\>\]][\s]*/g, '');
    }
    lyrics = lyrics.trim();
    if (lyrics.length > 4000) lyrics = lyrics.substring(0, 3997) + '...';
    await sock.sendMessage(jid, { text: `🎵 *${selectedTrack.trackName || 'Desconocido'} - ${selectedTrack.artistName || 'Desconocido'}*\n\n${lyrics}` });
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error al buscar la letra: ' + e.message });
  }
}

async function cmdPin(sock, jid, query) {
  try {
    if (!query || query.trim().length === 0) {
      await sock.sendMessage(jid, { text: '❌ Debes especificar qué buscar en Pinterest.' });
      return;
    }
    const response = await fetch(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);
    const html = await response.text();
    const matches = html.match(/https:\/\/i\.pinimg\.com\/[^"\s]+/g) || [];
    const filteredImages = matches.filter(url => url.includes('/236x/') || url.includes('/474x/') || url.includes('/736x/') || url.includes('/originals/'));
    const uniqueImages = [...new Set(filteredImages)];
    if (uniqueImages.length === 0) {
      await sock.sendMessage(jid, { text: '❌ No se encontraron imágenes.' });
      return;
    }
    const maxIndex = Math.min(15, uniqueImages.length);
    let selectedImage = uniqueImages[Math.floor(Math.random() * maxIndex)].replace(/\/\d+x\//, '/originals/');
    await sock.sendMessage(jid, { image: { url: selectedImage }, caption: `📌 Resultado para: *${query}*` });
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error al buscar en Pinterest: ' + e.message });
  }
}

async function cmdReddit(sock, jid, query, isNSFW) {
  try {
    if (!query || query.trim().length === 0) {
      await sock.sendMessage(jid, { text: '❌ Debes especificar qué buscar en Reddit.' });
      return;
    }
    if (isNSFW && !nsfwEnabled) {
      await sock.sendMessage(jid, { text: '❌ El contenido NSFW está desactivado. Usa /+18on para activarlo.' });
      return;
    }
    let url = query.includes(' ') ? `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=40` : `https://www.reddit.com/r/${encodeURIComponent(query)}/hot.json?limit=40`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);
    const json = await response.json();
    let posts = json.data?.children || [];
    if (posts.length === 0) {
      await sock.sendMessage(jid, { text: '❌ No se encontraron resultados.' });
      return;
    }
    let filteredPosts = isNSFW ? posts.filter(p => p.data?.over_18 === true) : posts.filter(p => !p.data?.over_18);
    if (filteredPosts.length === 0) {
      await sock.sendMessage(jid, { text: '❌ No se encontraron resultados con los filtros aplicados.' });
      return;
    }
    const post = filteredPosts[Math.floor(Math.random() * Math.min(15, filteredPosts.length))].data;
    const isImage = post.url && (post.url.endsWith('.jpg') || post.url.endsWith('.png') || post.url.endsWith('.jpeg') || post.url.includes('i.redd.it'));
    const footer = `\n\n📎 ${post.subreddit_name_prefixed || 'r/unknown'}\n🔗 https://reddit.com${post.permalink}`;
    if (isImage) {
      await sock.sendMessage(jid, { image: { url: post.url }, caption: (post.title || 'Sin título') + footer });
    } else {
      await sock.sendMessage(jid, { text: `${post.title || 'Sin título'}\n\n${(post.selftext || '').substring(0, 500)}${footer}` });
    }
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error al buscar en Reddit: ' + e.message });
  }
}

async function cmdRuleta(sock, jid, query) {
  try {
    if (!query || query.trim().length === 0) {
      await sock.sendMessage(jid, { text: '❌ Debes hacer una pregunta para la ruleta.' });
      return;
    }
    let probabilidad = 0.5, pregunta = query;
    const partes = query.split(' ');
    const ultimaParte = partes[partes.length - 1];
    if (ultimaParte.includes(';')) {
      const probParts = ultimaParte.split(';');
      if (probParts.length === 2 && !isNaN(probParts[0]) && !isNaN(probParts[1])) {
        const casosFavorables = parseInt(probParts[0]);
        const casosTotales = parseInt(probParts[1]);
        if (casosTotales > 0 && casosFavorables > 0) {
          probabilidad = casosFavorables / casosTotales;
          pregunta = partes.slice(0, -1).join(' ');
        }
      }
    }
    if (modoTrucado) {
      const preguntaLower = pregunta.toLowerCase();
      if (((preguntaLower.includes('maxi') || preguntaLower.includes('máximo')) && preguntaLower.includes('femboy')) ||
          (preguntaLower.includes('dylan') && preguntaLower.includes('perra')) || preguntaLower.includes('omeguita')) {
        await sock.sendMessage(jid, { text: '🔴 si' });
        return;
      }
    }
    await sock.sendMessage(jid, { text: (Math.random() < probabilidad) ? '🔴 si' : '⚫ no' });
  } catch (e) {
    await sock.sendMessage(jid, { text: '❌ Error en la ruleta: ' + e.message });
  }
}
// ==================== CONEXIÓN CON BAILEYS ====================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session_v3');
  let version = [2, 3000, 1017551063];

  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (e) {
    console.log('Usando versión de respaldo interna de Baileys.');
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !fs.existsSync('./auth_session_v3/creds.json'),
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' })
  });

  // Interceptor del prefijo global [¡+!]
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
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) ?
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      if (shouldReconnect) {
        console.log('Conexión perdida. Reconectando en 10 segundos...');
        await delay(10000);
        connectToWhatsApp();
      } else {
        console.log('Sesión destruida. Cerrando proceso.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      console.log('¡Bot conectado exitosamente al grupo!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });

  return sock;
}

// ==================== MANEJO Y FILTRADO DE MENSAJES ====================
async function handleMessage(sock, msg) {
  try {
    if (!msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    const senderJid = fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid;
    
    let text = '';
    if (msg.message.conversation) {
      text = msg.message.conversation;
    } else if (msg.message.extendedTextMessage) {
      text = msg.message.extendedTextMessage.text || '';
    } else if (msg.message.imageMessage && msg.message.imageMessage.caption) {
      text = msg.message.imageMessage.caption;
    }

    if (remoteJid !== GRUPO_PERMITIDO) return;
    if (!text.startsWith('/')) return;

    // Admin si figura en ADMIN_JIDS o si escribe desde el propio celular del bot (fromMe)
    const esAdmin = ADMIN_JIDS.includes(senderJid) || fromMe;
    
    if (baneadosData.baneados.includes(senderJid) && !esAdmin) return;
    if (!botEnabled && !esAdmin) return;

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();
    const argumento = args.slice(1).join(' ');

    // --- ENRUTADOR DE COMANDOS DE ADMINISTRADOR ---
    if (command === '/status' && esAdmin) {
      await cmdStatus(sock, remoteJid);
    } else if (command === '/on' && esAdmin) {
      await cmdToggleBot(sock, remoteJid, true);
    } else if (command === '/off' && esAdmin) {
      await cmdToggleBot(sock, remoteJid, false);
    } else if (command === '/+18on' && esAdmin) {
      await cmdToggleNsfw(sock, remoteJid, true);
    } else if (command === '/+18off' && esAdmin) {
      await cmdToggleNsfw(sock, remoteJid, false);
    } else if (command === '/modotrucadoon' && esAdmin) {
      await cmdToggleTrucado(sock, remoteJid, true);
    } else if (command === '/modotrucadooff' && esAdmin) {
      await cmdToggleTrucado(sock, remoteJid, false);
    } else if (command === '/ban' && esAdmin) {
      await cmdBanUser(sock, remoteJid, msg);
    } else if (command === '/unban' && esAdmin) {
      await cmdUnbanUser(sock, remoteJid, msg);
    }
    // --- ENRUTADOR DE COMANDOS PÚBLICOS ---
    else if (command === '/google') {
      await cmdGoogle(sock, remoteJid, argumento, 'flash');
    } else if (command === '/googlep') {
      await cmdGoogle(sock, remoteJid, argumento, 'pro');
    } else if (command === '/letras') {
      await cmdLetras(sock, remoteJid, argumento);
    } else if (command === '/pin') {
      await cmdPin(sock, remoteJid, argumento);
    } else if (command === '/reddit') {
      // Sensible a mayúsculas para diferenciar /reddit de /reddIt (NSFW)
      const esNSFW = args[0] === '/reddIt';
      await cmdReddit(sock, remoteJid, argumento, esNSFW);
    } else if (command === '/ruleta') {
      await cmdRuleta(sock, remoteJid, argumento);
    }

  } catch (error) {
    console.error('Error procesando handleMessage:', error);
  }
}

// ==================== SERVIDOR EXPRESS (RENDER WEBSERVICE) ====================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Servidor del Bot de WhatsApp Activo y en Línea.');
});

app.listen(PORT, () => {
  console.log(`Servidor Express levantado en puerto ${PORT}`);
});

// Lanzar ejecución
connectToWhatsApp().catch(err => {
  console.error('Fallo crítico en el inicio del script:', err);
  process.exit(1);
});
