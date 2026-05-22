const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// --- 1. CONFIGURACIÓN DEL SERVIDOR WEB (MONITOR DE RENDER) ---
const app = express();
const PORT = process.env.PORT || 10000;
const START_TIME = Date.now();

app.get('/', (req, res) => {
    const uptimeMinutes = ((Date.now() - START_TIME) / 1000 / 60).toFixed(2);
    res.json({
        status: "online",
        project: "WhatsApp Bot Pro",
        uptime_minutes: parseFloat(uptimeMinutes),
        environment: "Render Cloud"
    });
});

app.listen(PORT, () => {
    console.log(`[SERVER] 🌐 Monitor Express activo en el puerto ${PORT}`);
});

// --- 2. CONFIGURACIÓN OPTIMIZADA DEL CLIENTE (RUTA FIJA DE CHROME) ---
console.log('[BOT] Inicializando motor de WhatsApp con ruta fija...');
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        // Forzamos a Puppeteer a usar el Chrome exacto que descargó Render
        executablePath: '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    }
});

// --- 3. GESTIÓN DE EVENTOS DE CONEXIÓN ---

client.on('qr', (qr) => {
    console.log('\n[AUTH] 📌 NUEVO CÓDIGO QR GENERADO. ESCANÉALO ABAJO:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n==================================================');
    console.log('🎉 ¡SISTEMA PRO ACTIVADO! El bot está listo para usar. 🎉');
    console.log('==================================================\n');
});

client.on('disconnected', (reason) => {
    console.log(`[ALERTA] ❌ Bot desconectado. Razón: ${reason}`);
    process.exit(1);
});

// --- 4. SISTEMA CENTRAL DE COMANDOS ---
client.on('message', async (msg) => {
    const messageBody = msg.body.trim();

    if (!messageBody.startsWith('!')) return;

    const args = messageBody.slice(1).split(/ +/);
    const command = args.shift().toLowerCase();

    console.log(`[LOG] Comando ejecutado: !${command} | Por: ${msg.from}`);

    switch (command) {
        case 'hola':
            await msg.reply('🤖 *¡Modo Pro Activo!* Hola, estoy corriendo de forma estable en la nube 24/7. ¿En qué puedo ayudarte hoy? 🔥');
            break;

        case 'status':
        case 'ping':
            const uptime = ((Date.now() - START_TIME) / 1000 / 60).toFixed(1);
            const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
            
            const dashboard = 
                `📊 *ESTADO DEL SISTEMA PRO*\n\n` +
                `🟢 *Estado:* Operativo\n` +
                `⏱️ *Uptime:* ${uptime} minutos activos\n` +
                `💾 *RAM en uso:* ${memory} MB / 512 MB\n` +
                `☁️ *Servidor:* Render Cloud`;
            await msg.reply(dashboard);
            break;

        case 'reiniciar':
            await msg.reply('🔄 *Entendido.* Forzando reinicio del servidor en la nube... Dame unos 30 segundos.');
            setTimeout(() => {
                process.exit(0);
            }, 1500);
            break;

        default:
            break;
    }
});

// --- 5. SALVAVIDAS GLOBAL ---
process.on('unhandledRejection', (reason, p) => {
    console.error('[ERROR] Rechazo no manejado en promesa:', p, 'Razón:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[ERROR CRÍTICO] Excepción no controlada:', err);
    process.exit(1);
});

client.initialize();
        
