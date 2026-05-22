const { Client, LocalAuth } = require('whatsapp-web.js');
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

// --- NUEVA LÓGICA: Solo pedir código si REALMENTE no hay sesión ---
client.on('qr', async (qr) => {
    // Si ya tienes sesión, el bot no debería entrar aquí. 
    // Si entra, es que la sesión se perdió.
    const numeroTelefono = '5491128394646'; // Pon tu número aquí
    try {
        const pairingCode = await client.requestPairingCode(numeroTelefono);
        console.log(`\n🔑 CÓDIGO DE VINCULACIÓN: ${pairingCode}\n`);
    } catch (err) {
        console.error('Error al generar código:', err);
    }

client.on('ready', () => {
    console.log('\n==================================================');
    console.log('🎉 ¡SISTEMA PRO ACTIVADO! El bot está en la nube y conectado. 🎉');
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
    
