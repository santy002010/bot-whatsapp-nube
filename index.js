const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// --- 1. CONFIGURACIÓN DEL SERVIDOR WEB (MONITOR DE RENDER) ---
const app = express();
const PORT = process.env.PORT || 10000;
const START_TIME = Date.now(); // Guarda la hora exacta de encendido

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

// --- 2. CONFIGURACIÓN OPTIMIZADA DEL CLIENTE (ANTI-ERRORES) ---
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
            '--single-process' // Truco Pro: Reduce drásticamente el consumo de RAM en Render
        ]
    }
});

// --- 3. GESTIÓN DE EVENTOS DE CONEXIÓN ---

// Evento: Generar QR
client.on('qr', (qr) => {
    console.log('\n[AUTH] 📌 Nuevo código QR generado. Escanéalo desde tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

// Evento: Conectado con éxito
client.on('ready', () => {
    console.log('\n==================================================');
    console.log('🎉 ¡SISTEMA PRO ACTIVADO! El bot está listo para usar. 🎉');
    console.log('==================================================\n');
});

// Evento: Desconexión Crítica
client.on('disconnected', (reason) => {
    console.log(`[ALERTA] ❌ Bot desconectado del teléfono. Razón: ${reason}`);
    console.log('[SISTEMA] Reiniciando entorno para intentar re-vinculación...');
    process.exit(1); // Render lo encenderá de nuevo limpio automáticamente
});

// --- 4. SISTEMA CENTRAL DE COMANDOS (Estructura Limpia) ---
client.on('message', async (msg) => {
    const messageBody = msg.body.trim();

    // Filtro: Solo responde si el mensaje empieza con tu prefijo (ej: !)
    if (!messageBody.startsWith('!')) return;

    // Separa el comando de los argumentos
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
            console.log('[SISTEMA] Reinicio solicitado por el usuario. Apagando proceso...');
            setTimeout(() => {
                process.exit(0); // Render detecta el apagado y lo enciende al instante
            }, 1500);
            break;

        // 💡 AQUÍ PUEDES SEGUIR AGREGANDO MÁS COMANDOS FÁCILMENTE:
        // case 'ayuda':
        //     await msg.reply('Lista de comandos...');
        //     break;

        default:
            // Si escriben un comando que no existe, el bot no hace nada (evita spam)
            break;
    }
});

// --- 5. SALVAVIDAS GLOBAL (Evita que el bot muera por errores imprevistos) ---
process.on('unhandledRejection', (reason, p) => {
    console.error('[ERROR] Rechazo no manejado en promesa:', p, 'Razón:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[ERROR CRÍTICO] Excepción no controlada:', err);
    console.log('[SISTEMA] Ejecutando reinicio de emergencia preventivo...');
    process.exit(1);
});

// Encender el bot
client.initialize();
    
