import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
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
app.use(express.json());

const VALID_API_KEY = process.env.API_KEY || "";
const PORT = process.env.PORT || 3000;

const sessions = new Map();

async function initSession(sessionId) {
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) // Matikan log bawaan yang terlalu ramai
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
    const formattedNumber = number.startsWith('0') ? '62' + number.slice(1) + '@s.whatsapp.net' : number + '@s.whatsapp.net';

    try {
        await session.sock.sendMessage(formattedNumber, { text: message });
        res.json({ success: true, message: 'Pesan berhasil dikirim' });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengirim pesan', detail: error.message });
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