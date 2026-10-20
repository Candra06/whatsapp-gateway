import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, proto, getContentType } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Inisialisasi dotenv
dotenv.config();

// Re-create __dirname untuk ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Fix encoding: paksa UTF-8 dan terima berbagai Content-Type
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});
app.use(express.json({ type: ['application/json', 'text/plain', '*/*'] }));
app.use(express.urlencoded({ extended: true }));

const VALID_API_KEY = process.env.API_KEY || "";
const PORT = process.env.PORT || 3000;

const sessions = new Map();

// Store pesan per sesi — dibutuhkan agar WhatsApp bisa retry dekripsi E2E
// tanpa ini, penerima akan melihat "Menunggu pesan ini..."
const messageStores = new Map();

async function initSession(sessionId) {
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    // Inisialisasi store pesan untuk sesi ini
    if (!messageStores.has(sessionId)) {
        messageStores.set(sessionId, new Map());
    }
    const msgStore = messageStores.get(sessionId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        // ✅ FIX UTAMA: Diperlukan agar WhatsApp server bisa meminta ulang
        // pesan yang gagal didekripsi (Signal Protocol key ratchet retry)
        getMessage: async (key) => {
            const msgId = key.id;
            if (msgStore.has(msgId)) {
                return msgStore.get(msgId);
            }
            // Fallback: kembalikan pesan kosong agar tidak hang
            return { conversation: '' };
        }
    });

    sessions.set(sessionId, {
        sock: sock,
        status: 'INITIALIZING',
        qr: '',
        number: null
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const sessionData = sessions.get(sessionId);
        console.log(connection);
        // Jika mendapat string QR, ubah ke base64
        if (qr) {
            sessionData.status = 'WAITING_FOR_SCAN';
            sessionData.qr = await qrcode.toDataURL(qr);
            sessionData.number = null;
            console.log(`[${sessionId}] QR Code siap di-scan`);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[${sessionId}] Koneksi terputus. Alasan:`, lastDisconnect.error?.message);

            if (shouldReconnect) {
                sessionData.status = 'RECONNECTING';
                sessionData.number = null;
                console.log(`[${sessionId}] Mencoba menghubungkan kembali...`);
                initSession(sessionId); // Rekoneksi otomatis jika internet gangguan
            } else {
                console.log(`[${sessionId}] Perangkat di-logout. Menunggu trigger manual dari sistem...`);

                // Ubah status dan hapus sisa QR
                sessionData.status = 'LOGGED_OUT';
                sessionData.qr = '';
                sessionData.number = null;
                


                // Hapus folder sesi lama agar token kadaluarsa hilang
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                // Stop di sini (tidak memanggil initSession otomatis)
            }
        } else if (connection === 'open') {
            sessionData.status = 'CONNECTED';
            sessionData.qr = ''; // Bersihkan memori QR
            const userInfo = sessionData.sock.user;
            if (userInfo && userInfo.id) {
                // Memotong format "62812...:15@s.whatsapp.net" menjadi "62812..."
                const rawId = userInfo.id;
                sessionData.number = rawId.split(':')[0].split('@')[0];
            }
            console.log(`[${sessionId}] WhatsApp Berhasil Terhubung!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Simpan setiap pesan yang berhasil dikirim ke store
    // agar bisa di-retrieve saat WhatsApp meminta retry
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (msg.key?.id && msg.message) {
                msgStore.set(msg.key.id, msg.message);

                // Batasi ukuran store agar tidak memory leak (maks 500 pesan)
                if (msgStore.size > 500) {
                    const firstKey = msgStore.keys().next().value;
                    msgStore.delete(firstKey);
                }
            }
        }
    });
}

// --- MIDDLEWARE API KEY ---
const apiKeyMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== VALID_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
};
app.use(apiKeyMiddleware);

// 1. Mulai Sesi Baru / Generate QR
app.post('/api/session/start', async (req, res) => {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id wajib diisi' });

    // Cek apakah belum ada di memori, atau statusnya sedang LOGGED_OUT
    const currentSession = sessions.get(session_id);
    if (!currentSession || currentSession.status === 'LOGGED_OUT') {
        await initSession(session_id);
    }

    res.json({ success: true, message: `Sesi ${session_id} sedang diproses. Cek endpoint status untuk QR.` });
});

// 2. Cek Status Sesi & Ambil QR
app.get('/api/session/status/:session_id', (req, res) => {
    const sessionId = req.params.session_id;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Sesi tidak ditemukan. Silakan jalankan endpoint /start' });
    }

    res.json({
        success: true,
        session_id: sessionId,
        number: session.number,
        status: session.status,
        qr_code_base64: session.qr
    });
});

// 3. Kirim Pesan
app.post('/api/send-message/:session_id', async (req, res) => {
    const sessionId = req.params.session_id;
    const session = sessions.get(sessionId);

    if (!session || session.status !== 'CONNECTED') {
        return res.status(503).json({ error: `Sesi ${sessionId} tidak siap atau belum terhubung` });
    }

    const { number, message } = req.body;

    // Validasi input
    if (!number || !message) {
        return res.status(400).json({ error: 'Field "number" dan "message" wajib diisi' });
    }

    // Fix encoding: pastikan message adalah string UTF-8 yang valid
    let safeMessage;
    try {
        // Jika message berupa Buffer atau salah encode, konversi ke string UTF-8
        safeMessage = Buffer.from(String(message), 'utf-8').toString('utf-8');
    } catch (e) {
        return res.status(400).json({ error: 'Encoding pesan tidak valid, gunakan UTF-8' });
    }

    // Sanitasi nomor: hapus spasi, karakter tersembunyi, dan format yang tidak perlu
    const cleanNumber = String(number).replace(/[\s\-().+]/g, '').trim();
    const formattedNumber = cleanNumber.startsWith('0')
        ? '62' + cleanNumber.slice(1) + '@s.whatsapp.net'
        : cleanNumber + '@s.whatsapp.net';

    console.log(`[${sessionId}] Kirim ke: ${formattedNumber} | Pesan: ${safeMessage.substring(0, 50)}...`);

    try {
        await session.sock.sendMessage(formattedNumber, { text: safeMessage });
        res.json({ success: true, message: 'Pesan berhasil dikirim' });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengirim pesan', detail: error.message });
    }
});

// 4. Clear Cache Sesi (fix "Menunggu pesan ini...")
// Menghapus session folder (auth keys) + message store di memori,
// lalu reinisialisasi sesi agar dapat QR baru yang bersih
app.post('/api/session/clear-cache/:session_id', async (req, res) => {
    const sessionId = req.params.session_id;
    const session = sessions.get(sessionId);
    const sessionPath = path.join(__dirname, 'sessions', sessionId);

    try {
        // 1. Putuskan koneksi socket yang sedang berjalan
        if (session?.sock) {
            try {
                session.sock.ev.removeAllListeners();
                await session.sock.logout();
            } catch (_) {
                // Abaikan error logout, lanjutkan proses clear
            }
        }

        // 2. Hapus dari memori
        sessions.delete(sessionId);

        // 3. Bersihkan message store sesi ini
        if (messageStores.has(sessionId)) {
            messageStores.get(sessionId).clear();
            messageStores.delete(sessionId);
        }

        // 4. Hapus folder session di disk (auth keys & Signal Protocol state)
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${sessionId}] Cache session dihapus dari disk.`);
        }

        // 5. Reinisialisasi sesi baru → akan generate QR baru
        await initSession(sessionId);

        res.json({
            success: true,
            message: `Cache sesi ${sessionId} berhasil dihapus. Silakan scan ulang QR melalui endpoint /status.`
        });
    } catch (error) {
        console.error(`[${sessionId}] Gagal clear cache:`, error.message);
        res.status(500).json({ error: 'Gagal membersihkan cache sesi', detail: error.message });
    }
});

// Jalankan server dan load sesi yang tersimpan sebelumnya
app.listen(PORT, () => {
    console.log(`API Server Multi-Session berjalan di http://localhost:${PORT}`);

    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir);
    } else {
        const dirs = fs.readdirSync(sessionsDir);
        dirs.forEach(dir => {
            console.log(`Auto-loading sesi yang tersimpan: ${dir}`);
            initSession(dir);
        });
    }
});