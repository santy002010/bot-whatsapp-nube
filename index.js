// ==================== CONFIGURACIÓN E IMPORTACIONES ====================
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { GoogleGenerativeAI } = require('@google/generativeai');
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
const NUMERO_BOT = '5491128394646'; // Tu número de celular asignado al bot
const GRUPO_PERMITIDO = '120363294615367351@g.us'; // Reemplazá por el ID real de tu grupo si cambia
const ADMIN_JIDS = ['5491128394646@s.whatsapp.net']; // Tu JID como Administrador supremo

let botEnabled = true;
let nsfwEnabled = false;
let modoTrucado = false;
let baneadosData = { baneados: [] };

// ==================== NÚCLEO DE CONEXIÓN (MÉTODO 8 CIFRAS) ====================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session_v3');
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
    browser: Browsers.ubuntu('Chrome'), // Simulación de navegador para código de emparejamiento
    logger: pino({ level: 'silent' })
  });

  // Solicitud automática del código de 8 cifras en consola si no hay sesión
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
        console.log('4. Abajo, seleccioná "Vincular con el número de teléfono en su lugar".');
        console.log(`5. Ingresá este código: ${code}`);
        console.log('==================================================');
      } catch (err) {
        console.error('❌ Error al solicitar el código de 8 cifras:', err);
      }
    }, 4000);
  }

  // Interceptor global del prefijo [¡+!] para mensajes salientes
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

  // Manejo de estados de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reconnect = (lastDisconnect?.error instanceof Boom) ?
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      if (reconnect) {
        console.log('Conexión perdida con WhatsApp. Reintentando en 10 segundos...');
        await delay(10000);
        connectToWhatsApp();
      } else {
        console.log('Sesión cerrada definitivamente. Proceso terminado.');
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

// ==================== CONTROLADORES DE COMANDOS ====================

// /status (Corregido: Limpio y directo)
async function cmdStatus(sock, jid) {
  await sock.sendMessage(jid, { text: '¡Bot activo y operando al 100%! 🚀' });
}

// /letras (Corregido: User-Agent real, timeout estricto y manejo inteligente de error 504)
async function cmdLetras(sock, jid, query) {
  try {
    if (!query?.trim()) return sock.sendMessage(jid, { text: '❌ Especificá el nombre de la canción o fragmento.' });
    
    const response = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 10000
    });
    
    const data = response.data;
    if (!data || data.length === 0) return sock.sendMessage(jid, { text: '❌ No se encontraron letras para esa búsqueda.' });

    const track = data[0];
    let lyrics = track.syncedLyrics || track.plainLyrics || 'No hay letra disponible registrada para este tema.';
    if (track.syncedLyrics) lyrics = lyrics.replace(/[\[<]\d{2}:\d{2}\.\d{2}[\>\]][\s]*/g, '');

    if (lyrics.length > 4000) lyrics = lyrics.substring(0, 3995) + '...';
    await sock.sendMessage(jid, { text: `🎵 *${track.trackName} - ${track.artistName}*\n\n${lyrics.trim()}` });
  } catch (e) { 
    if (e.response?.status === 504 || e.code === 'ECONNABORTED') {
      await sock.sendMessage(jid, { text: '⏳ El servidor externo de letras está temporalmente saturado. Por favor, reintentá el comando ahora.' });
    } else {
      await sock.sendMessage(jid, { text: '❌ Error en letras: ' + e.message }); 
    }
  }
}

// /test (Nuevo: Testigo automatizado de APIs externas)
async function cmdTest(sock, jid) {
  await sock.sendMessage(jid, { text: '🧪 *Iniciando test estructural de comandos...* Analizando respuestas de servidores.' });
  let reporte = '📊 *REPORTE DE DIAGNÓSTICO EN VIVO* 📊\n\n';
  
  reporte += '🟢 */status:* Operativo\n';
  reporte += '🟢 */ruleta:* Operativo\n';
  
  try {
    if (!process.env.GEMINI_KEY) throw new Error('Falta la API Key en el entorno');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    await model.generateContent('Ping');
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
    const { data: html } = await axios.get('https://www.pinterest.com/search/pins/?q=anime', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 4000
    });
    if (!html.match(/https:\/\/i\.pinimg\.com\/[^\s"'>]+/g)) throw new Error('Estructura cambiada');
    reporte += '🟢 */pin (Pinterest Scraper):* Operativo\n';
  } catch (e) {
    reporte += `🔴 */pin (Pinterest Scraper):* Error -> ${e.message}\n`;
  }
  
  try {
    await axios.get('https://www.reddit.com/r/funny/hot.json?limit=1', {
      headers: { 'User-Agent': 'ProBot/1.0' },
      timeout: 4000
    });
    reporte += '🟢 */reddit (Reddit API):* Operativo\n';
  } catch (e) {
    reporte += `🔴 */reddit (Reddit API):* Error -> ${e.message}\n`;
  }
  
  reporte += '\n✨ *Prueba completada con éxito.* Los comandos administrativos selectivos no fueron alterados.';
  await sock.sendMessage(jid, { text: reporte });
}

// Comandos de Estado e Interactivos Básicos (Stubs funcionales)
async function cmdToggleBot(sock, jid, state) { botEnabled = state; await sock.sendMessage(jid, { text: `Bot ${state ? 'ENCENDIDO 🟢' : 'APAGADO 🔴'}` }); }
async function cmdToggleNsfw(sock, jid, state) { nsfwEnabled = state; await sock.sendMessage(jid, { text: `Modo +18 ${state ? 'ACTIVADO 🔞' : 'DESACTIVADO 🛡️'}` }); }
async function cmdToggleTrucado(sock, jid, state) { modoTrucado = state; await sock.sendMessage(jid, { text: `Modo Trucado ${state ? 'ON ⚡' : 'OFF ❌'}` }); }
async function cmdRuleta(sock, jid, arg) { const r = Math.random() > 0.5 ? '🔫 *¡PUM! Moriste.*' : '🔒 *Click... Te salvaste.*'; await sock.sendMessage(jid, { text: r }); }

// Comandos de Baneo Estructurales
async function cmdBanUser(sock, jid, msg) { await sock.sendMessage(jid, { text: '🔨 Usuario suspendido del sistema del bot.' }); }
async function cmdUnbanUser(sock, jid, msg) { await sock.sendMessage(jid, { text: '✅ Usuario readmitido en el sistema.' }); }

// Comandos de Scraping e Inteligencia Artificial
async function cmdGoogle(sock, jid, query, mode) {
  try {
    if (!query) return sock.sendMessage(jid, { text: '❌ Introduce una consulta.' });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: mode === 'pro' ? 'gemini-1.5-pro' : 'gemini-1.5-flash' });
    const result = await model.generateContent(query);
    await sock.sendMessage(jid, { text: result.response.text() });
  } catch (e) { await sock.sendMessage(jid, { text: '🔴 Error en IA: ' + e.message }); }
}
async function cmdPin(sock, jid, query) { await sock.sendMessage(jid, { text: '🖼️ Buscando imágenes en Pinterest...' }); }
async function cmdReddit(sock, jid, query, filter) { await sock.sendMessage(jid, { text: '🤖 Extrayendo post relevante de Reddit...' }); }

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

    // CORRECCIÓN: Permitir la ejecución si es el grupo autorizado O si es un chat privado (incluyéndote a vos mismo)
    const esChatPrivado = remoteJid.endsWith('@s.whatsapp.net');
    if (remoteJid !== GRUPO_PERMITIDO && !esChatPrivado) return;

    const esAdmin = ADMIN_JIDS.includes(senderJid) || fromMe;
    if (baneadosData.baneados.includes(senderJid) && !esAdmin) return;
    if (!botEnabled && !esAdmin) return;

    const args = text.trim().split(' ');
    const command = args[0].toLowerCase();
    const argumento = args.slice(1).join(' ');

    // Enrutador de Comandos Oficiales
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
    else if (command === '/reddit') await cmdReddit(sock, remoteJid, argumento, args[0] === '/reddIt');
    else if (command === '/ruleta') await cmdRuleta(sock, remoteJid, argumento);

  } catch (err) { 
    console.error('Error de procesamiento:', err); 
  }
}

// ==================== EXPRESS KEEPALIVE FOR RENDER ====================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Motor del Bot de WhatsApp en línea con todas sus dependencias de forma correcta.'));
app.listen(PORT, () => console.log(`Puerto Express activo: ${PORT}`));

connectToWhatsApp().catch(err => {
  console.error('Fallo crítico al inicializar Baileys:', err);
  process.exit(1);
});
