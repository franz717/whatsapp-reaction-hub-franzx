const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let client;
let isClientReady = false;
let currentQR = null;

console.log('🚀 WhatsApp Reaction Hub Starting...');

// Initialize WhatsApp
function initWhatsApp() {
    client = new Client({
        authStrategy: new LocalAuth({ clientId: "reaction-bot" }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });

    client.on('qr', async (qr) => {
        console.log('📱 QR CODE RECEIVED - SCAN WITH WHATSAPP');
        qrcode.generate(qr, { small: true });
        currentQR = qr;
        
        // Generate QR image untuk web
        try {
            await QRCode.toFile('./public/qr.png', qr);
            console.log('✅ QR image saved');
        } catch (err) {
            console.log('QR save error:', err);
        }
    });

    client.on('ready', () => {
        console.log('✅ WHATSAPP CLIENT READY!');
        isClientReady = true;
        currentQR = null;
    });

    client.on('auth_failure', (msg) => {
        console.log('❌ AUTH FAILED:', msg);
        isClientReady = false;
    });

    client.on('disconnected', () => {
        console.log('🔌 Disconnected, restarting...');
        isClientReady = false;
        setTimeout(() => initWhatsApp(), 3000);
    });

    client.initialize();
}

// Start WhatsApp
initWhatsApp();

// ==================== ROUTES ====================

// Homepage
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Status endpoint
app.get('/api/status', (req, res) => {
    res.json({
        ready: isClientReady,
        hasQr: !!currentQR,
        message: isClientReady ? 'WhatsApp connected!' : 'Scan QR first'
    });
});

// Get QR code
app.get('/api/qr', async (req, res) => {
    if (isClientReady) {
        return res.json({ hasQr: false, message: 'Already connected' });
    }
    
    if (!currentQR) {
        return res.json({ hasQr: false, message: 'QR not ready, wait...' });
    }
    
    try {
        const qrDataUrl = await QRCode.toDataURL(currentQR);
        res.json({ hasQr: true, qr: qrDataUrl });
    } catch (err) {
        res.json({ hasQr: false, error: err.message });
    }
});

// MAIN ENDPOINT: SEND REACTION
app.post('/api/send-reaction', async (req, res) => {
    console.log('📩 Request received:', req.body);
    
    if (!isClientReady) {
        return res.json({
            success: false,
            error: 'WhatsApp not connected. Please scan QR code first at /scan.html'
        });
    }
    
    const { chatUrl, emojis, count } = req.body;
    
    // VALIDASI INPUT
    if (!chatUrl || !emojis || !count) {
        return res.json({
            success: false,
            error: 'Missing data! Need: chatUrl, emojis, count'
        });
    }
    
    // PARSE URL CHAT WHATSAPP
    // Format yang diterima:
    // 1. https://web.whatsapp.com/accept?code=xxxx
    // 2. https://wa.me/6281234567890
    // 3. https://chat.whatsapp.com/xxxx (group)
    
    let phoneNumber = null;
    let isGroup = false;
    
    try {
        // Format 1: web.whatsapp.com
        if (chatUrl.includes('web.whatsapp.com')) {
            const urlObj = new URL(chatUrl);
            const code = urlObj.searchParams.get('code');
            if (code) {
                // Untuk demo, kita ambil dari parameter
                phoneNumber = '6281234567890'; // DEFAULT, USER GANTI MANUAL
            }
        }
        // Format 2: wa.me
        else if (chatUrl.includes('wa.me/')) {
            const match = chatUrl.match(/wa\.me\/(\d+)/);
            if (match) {
                phoneNumber = match[1];
            }
        }
        // Format 3: chat.whatsapp.com (group)
        else if (chatUrl.includes('chat.whatsapp.com/')) {
            const parts = chatUrl.split('/');
            const groupCode = parts[parts.length - 1];
            phoneNumber = `${groupCode}@g.us`;
            isGroup = true;
        }
        // Format 4: langsung nomor
        else if (/^\d+$/.test(chatUrl.replace(/\D/g, ''))) {
            phoneNumber = chatUrl.replace(/\D/g, '');
        }
        
        // Format nomor (harus 62...)
        if (phoneNumber && !phoneNumber.includes('@')) {
            if (!phoneNumber.startsWith('62')) {
                if (phoneNumber.startsWith('0')) {
                    phoneNumber = '62' + phoneNumber.substring(1);
                } else if (phoneNumber.startsWith('8')) {
                    phoneNumber = '62' + phoneNumber;
                }
            }
            phoneNumber = isGroup ? phoneNumber : phoneNumber + '@c.us';
        }
        
        if (!phoneNumber) {
            return res.json({
                success: false,
                error: 'Invalid WhatsApp URL. Please use: wa.me/628xxx or chat.whatsapp.com link'
            });
        }
        
        console.log(`📍 Target: ${phoneNumber} (${isGroup ? 'Group' : 'Personal'})`);
        
        // PROSES EMOJI
        const emojiList = emojis.split(',').map(e => e.trim()).filter(e => e);
        const reactionCount = parseInt(count) || 1;
        
        if (emojiList.length === 0) {
            return res.json({ success: false, error: 'No valid emojis provided' });
        }
        
        if (reactionCount > 20) {
            return res.json({ success: false, error: 'Max 20 reactions at once' });
        }
        
        // KIRIM REACTION
        const results = [];
        
        for (let i = 0; i < reactionCount; i++) {
            const emoji = emojiList[i % emojiList.length];
            
            try {
                // Cari chat terakhir untuk dikasih reaction
                const chat = await client.getChatById(phoneNumber);
                const messages = await chat.fetchMessages({ limit: 1 });
                
                if (messages.length > 0) {
                    const lastMsg = messages[0];
                    
                    // Kirim reaction
                    await lastMsg.react(emoji);
                    
                    results.push({
                        number: i + 1,
                        emoji: emoji,
                        status: 'sent',
                        to: phoneNumber
                    });
                    
                    console.log(`✅ Reaction ${i+1}: ${emoji} sent to ${phoneNumber}`);
                } else {
                    // Jika tidak ada pesan, kirim pesan dulu lalu react
                    const sentMsg = await client.sendMessage(phoneNumber, `Reaction test from bot 🚀`);
                    await sentMsg.react(emoji);
                    
                    results.push({
                        number: i + 1,
                        emoji: emoji,
                        status: 'sent_with_message',
                        to: phoneNumber
                    });
                }
                
                // Delay 1 detik antara reaction
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`❌ Error reaction ${i+1}:`, error.message);
                results.push({
                    number: i + 1,
                    emoji: emoji,
                    status: 'failed',
                    error: error.message
                });
            }
        }
        
        // RESPON SUKSES
        res.json({
            success: true,
            message: `Sent ${results.filter(r => r.status === 'sent').length} reactions`,
            totalRequested: reactionCount,
            sent: results.filter(r => r.status.includes('sent')).length,
            failed: results.filter(r => r.status === 'failed').length,
            results: results,
            target: phoneNumber
        });
        
    } catch (error) {
        console.error('❌ Server error:', error);
        res.json({
            success: false,
            error: `Server error: ${error.message}`
        });
    }
});

// Port configuration
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🔥 Server running on port ${PORT}`);
    console.log(`🌐 Access at: https://your-app.railway.app`);
});
