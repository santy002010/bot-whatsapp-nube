const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// --- 1. CONFIGURACIÓN DEL SERVIDOR WEB ---
const app = express();
const PORT = process.env.PORT || 10000;
const START_TIME = Date.now();

app.get('/', (req, res) => {
    const uptimeMinutes = ((Date.now() - START_TIME) / 1000 / 60).toFixed(2);
    res.json({ status: "online", project: "WhatsApp Bot Pro", uptime_minutes: parseFloat(uptimeMinutes) });
});

app.listen(PORT, () => {
    console.log(`[SERVER] 🌐 Monitor Express activo en el puerto ${PORT}`);
});

// --- 2. CONFIGURACIÓN OPTIMIZADA DEL CLIENTE ---
console.log('[BOT] Inicializando motor de WhatsApp...');
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        // Eliminamos la ruta manual. La variable de entorno de Render hará el trabajo.
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

// --- 3. EVENTOS DE CONEXIÓN ---
client.on('qr', (qr) => {
    console.log('\n[AUTH] 📌 NUEVO CÓDIGO QR GENERADO. ESCANÉALO ABAJO:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n==================================================');
    console.log('🎉 ¡SISTEMA PRO ACTIVADO! El bot está en la nube. 🎉');
    console.log('==================================================\n');
});

client.on('disconnected', (reason) => {
    console.log(`[ALERTA] ❌ Bot desconectado. Razón: ${reason}`);
    process.exit(1);
});

// --- 4. COMANDOS ---
client.on('message', async (msg) => {
    const messageBody = msg.body.trim();
    if (!messageBody.startsWith('!')) return;

    const args = messageBody.slice(1).split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
        case 'hola':
            await msg.reply('🤖 *¡Modo Pro Activo!* Hola, estoy corriendo estable 24/7.');
            break;
        case 'status':
        case 'ping':
            const uptime = ((Date.now() - START_TIME) / 1000 / 60).toFixed(1);
            const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
            await msg.reply(`📊 *ESTADO*\n🟢 Operativo\n⏱️ ${uptime} min\n💾 RAM: ${memory} MB`);
            break;
        case 'reiniciar':
            await msg.reply('🔄 Reiniciando bot en la nube...');
            setTimeout(() => { process.exit(0); }, 1500);
            break;
    }
});

// --- 5. SALVAVIDAS ---
process.on('unhandledRejection', (reason, p) => {
    console.error('[ERROR] Promesa rechazada:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[CRÍTICO] Excepción:', err);
    process.exit(1);
});

client.initialize();
                
