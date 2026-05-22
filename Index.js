const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const express = require('express'); // <-- NUEVO: Necesario para la nube

// --- MINI SERVIDOR WEB PARA QUE RENDER NO LO APAGUE ---
const app = express();
app.get('/', (req, res) => res.send('🤖 El bot está despierto y funcionando en la nube.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor web escuchando en el puerto ${PORT}`));

// --- AJUSTE DE IDENTIDADES ---
const ID_DEL_CHAT = '120363426591951143@g.us'; 
const NUMERO_TELEFONO_BOT = 'TU_NUMERO_BOT_AQUI'; 

let botActivo = true;
let nsfwActivado = false; 
let listaNegra = [];

if (fs.existsSync('./listaNegra.json')) {
    try { listaNegra = JSON.parse(fs.readFileSync('./listaNegra.json', 'utf-8')); } catch (e) { listaNegra = []; }
}

function guardarListaNegra() {
    fs.writeFileSync('./listaNegra.json', JSON.stringify(listaNegra, null, 2));
}

// --- CONFIGURACIÓN CLIENTE PARA LA NUBE ---
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'mi-bot-whatsapp' }),
    puppeteer: {
        // Quitamos la ruta de Termux. Render descargará su propio Chromium automáticamente.
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

// --- EVENTOS DE ARRANQUE ---
client.on('qr', async qr => {
    if (NUMERO_TELEFONO_BOT !== 'TU_NUMERO_BOT_AQUI') {
        try {
            console.log('\n⏳ Solicitando código de emparejamiento a WhatsApp...');
            const code = await client.requestPairingCode(NUMERO_TELEFONO_BOT);
            console.log('\n=======================================');
            console.log('📱 CÓDIGO DE EMPAREJAMIENTO: ' + code);
            console.log('=======================================\n');
        } catch (e) {
            console.log('❌ Error pidiendo el código, mostrando QR de emergencia:');
            qrcode.generate(qr, { small: true });
        }
    } else {
        qrcode.generate(qr, { small: true });
    }
});

client.on('ready', () => {
    console.log('\n=======================================');
    console.log('🚀 BOT LISTO Y FUNCIONANDO EN LA NUBE');
    console.log('=======================================\n');
});

// --- LÓGICA PRINCIPAL ---
client.on('message_create', async msg => {
    const remitente = msg.author || msg.from;
    
    if (msg.from !== ID_DEL_CHAT && msg.to !== ID_DEL_CHAT && msg.id.remote !== ID_DEL_CHAT) return;
    
    const esAdmin = msg.fromMe || (remitente && remitente.includes('1128394646'));
    if (listaNegra.includes(remitente) && !esAdmin) return;

    const cuerpo = msg.body || '';
    const partes = cuerpo.split(/\s+/);
    const comando = partes[0].toLowerCase();
    const busqueda = partes.slice(1).join(' ');

    if (esAdmin) {
        if (comando === '/off') { botActivo = false; return msg.reply('💤 Bot apagado.'); }
        if (comando === '/on') { botActivo = true; return msg.reply('✅ Bot encendido.'); }
        if (comando === '/+18on') { nsfwActivado = true; return msg.reply('🔥 Modo +18 Activado.'); }
        if (comando === '/+18off') { nsfwActivado = false; return msg.reply('🔞 Modo +18 Desactivado.'); }
        if (comando === '/ban' && msg.hasQuotedMsg) {
            const q = await msg.getQuotedMessage();
            const target = q.author || q.from;
            if (!listaNegra.includes(target)) {
                listaNegra.push(target);
                guardarListaNegra();
                return msg.reply('🚫 Usuario bloqueado.');
            }
        }
        if (comando === '/unban' && busqueda) {
            const target = busqueda.includes('@') ? busqueda : busqueda.replace(/[^0-9]/g, '') + '@c.us';
            listaNegra = listaNegra.filter(id => id !== target);
            guardarListaNegra();
            return msg.reply('✅ Usuario desbloqueado.');
        }
    }

    if (!botActivo || !cuerpo.startsWith('/')) return;

    if (!nsfwActivado) {
        const check = (cuerpo + busqueda).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (['rule34','r34','porno','xxx','hentai','nude','gore','tetas','cuca'].some(p => check.includes(p))) {
            return msg.reply('👮‍♂️ Comando denegado.');
        }
    }

    if (comando === '/google') {
        if (!busqueda) return msg.reply('⚠️ Ejemplo: /google nodejs');
        msg.reply(`🌐 Resultados en Google:\nhttps://www.google.com/search?q=${encodeURIComponent(busqueda)}`);
    }
});

client.initialize();
  
