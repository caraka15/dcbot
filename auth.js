// --- DEPENDENCIES ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { authenticator } = require('otplib');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

const CONFIG_PATH = path.resolve(__dirname, 'config.json');

// --- FUNGSI HELPER ---
const readConfig = async () => JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
const writeConfig = async (data) => await fs.writeFile(CONFIG_PATH, JSON.stringify(data, null, 4), 'utf-8');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function askQuestion(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.toLowerCase());
    }));
}

// --- FUNGSI INISIALISASI WHATSAPP ---
function initializeWhatsApp(client) {
    return new Promise((resolve, reject) => {
        console.log('\nMenginisialisasi WhatsApp...');
        client.on('qr', (qr) => {
            console.log('================================================');
            console.log('Pindai QR Code ini dengan WhatsApp di ponsel Anda:');
            qrcode.generate(qr, { small: true });
            console.log('================================================');
        });
        client.on('ready', () => {
            console.log('✅ Client WhatsApp Siap!');
            resolve(client);
        });
        client.on('auth_failure', (msg) => {
            console.error('❌ Autentikasi WhatsApp GAGAL:', msg);
            reject(new Error('Authentication Failure'));
        });
        client.initialize().catch(err => reject(err));
    });
}

// --- FUNGSI LOGIKA DISCORD (API & LOGIN) ---
async function checkTokenAndFetchPolls(token, channelId) {
    console.log(`📡 Menghubungi API untuk mengambil data polls dari channel ${channelId}...`);
    const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=50`;
    const headers = { "Authorization": token, "User-Agent": "Mozilla/5.0" };
    try {
        const response = await fetch(url, { headers });
        if (response.status === 401) return { status: 'unauthorized' };
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        return { status: 'success', data: await response.json() };
    } catch (error) { return { status: 'error', data: error.message }; }
}

async function voteOnPoll(token, account, message, whatsappClient) {
    const poll = message.poll;
    if (!poll.answers || poll.answers.length === 0) return;

    const randomIndex = Math.floor(Math.random() * poll.answers.length);
    const chosenAnswer = poll.answers[randomIndex];
    const answerId = chosenAnswer.answer_id.toString();
    const answerText = chosenAnswer.poll_media.text;
    const questionText = poll.question.text;

    console.log(`🗳️  Memilih jawaban acak #${answerId} ("${answerText}") untuk poll: "${questionText}"`);
    const url = `https://discord.com/api/v9/channels/${message.channel_id}/polls/${message.id}/answers/@me`;
    const headers = { "Authorization": token, "User-Agent": "Mozilla/5.0", "Content-Type": "application/json" };
    const body = JSON.stringify({ "answer_ids": [answerId] });

    try {
        const response = await fetch(url, { method: 'PUT', headers, body });
        if (response.status === 204) {
            console.log(`✅ Vote berhasil!`);
            // Kirim notifikasi HANYA jika whatsappClient ada (tidak null)
            if (whatsappClient && account.whatsappNumber) {
                const chatId = `${account.whatsappNumber}@c.us`;
                const notificationMessage = `*Vote Berhasil Terkirim!* 🗳️\n\n*Akun:*\n${account.accountName}\n\n*Pertanyaan:*\n${questionText}\n\n*Jawaban Anda (acak):*\n${answerText}`;
                try {
                    await whatsappClient.sendMessage(chatId, notificationMessage);
                    console.log(`📱 Notifikasi WhatsApp terkirim ke ${account.whatsappNumber}`);
                } catch (waErr) {
                    console.error(`❌ Gagal mengirim notifikasi WA ke ${account.whatsappNumber}:`, waErr.message);
                }
            }
        } else {
            console.error(`❌ Gagal vote, status: ${response.status}`, await response.text());
        }
    } catch (error) {
        console.error('❌ Terjadi error saat melakukan vote:', error);
    }
}

async function getNewTokenForAccount(accountConfig) {
    console.log(`🤖 Menjalankan fungsi login ulang untuk ${accountConfig.accountName}...`);
    let browser;
    let newToken = null;
    try {
        const userDataDir = path.resolve(__dirname, accountConfig.userDataDir);
        console.log(`Membersihkan sesi lama di: ${userDataDir}`);
        if (fs.existsSync(userDataDir)) await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.mkdir(userDataDir, { recursive: true });

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const headers = request.headers();
            if (headers.authorization && !newToken) {
                console.log('🔑 Token baru ditemukan dari network request!');
                newToken = headers.authorization;
            }
            if (!request.isInterceptResolutionHandled()) request.continue();
        });

        await page.goto("https://discord.com/login", { waitUntil: 'networkidle2' });
        await page.type('input[name="email"]', accountConfig.email, { delay: 50 });
        await page.type('input[name="password"]', accountConfig.password, { delay: 50 });
        await page.click('button[type="submit"]');

        try {
            await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: 10000 });
            const twoFactorCode = authenticator.generate(accountConfig.twoFactorSecret);
            await page.type('input[autocomplete="one-time-code"]', twoFactorCode);
            await page.click('button[type="submit"]');
            await page.waitForNavigation({ waitUntil: 'networkidle2' });
        } catch (e) { console.log("2FA tidak diminta atau timeout."); }

        console.log('Menunggu 10 detik untuk memastikan semua request selesai dan token tertangkap...');
        await delay(10000);
        await browser.close();

        if (newToken) {
            console.log('✅ Login ulang berhasil, token baru didapatkan.');
            return newToken;
        } else {
            throw new Error("Gagal mendapatkan token baru setelah login.");
        }
    } catch (error) {
        console.error(`❌ Error besar saat login ulang: ${error.message}`);
        if (browser) await browser.close();
        return null;
    }
}

// =================================================================
// --- FUNGSI SIKLUS UTAMA ---
// =================================================================

async function runDiscordCycle(whatsappClient) {
    const config = await readConfig();
    const parts = config.pollChannelUrl.split('/');
    const channelId = parts.pop() || parts.pop();
    console.log(`🎯 Channel ID target diatur ke: ${channelId}`);

    for (let i = 0; i < config.accounts.length; i++) {
        let account = config.accounts[i];
        console.log(`\n--- Memproses Akun: ${account.accountName} ---`);

        try {
            let currentToken = account.authToken;
            if (!currentToken) {
                console.warn(`⚠️ Token kosong, memulai login...`);
                currentToken = await getNewTokenForAccount(account);
                if (!currentToken) throw new Error("Gagal login, skip akun.");
                let currentConfig = await readConfig();
                currentConfig.accounts[i].authToken = currentToken;
                await writeConfig(currentConfig);
            }

            let result = await checkTokenAndFetchPolls(currentToken, channelId);
            if (result.status === 'unauthorized') {
                console.warn('⚠️ Token kadaluwarsa, login ulang...');
                currentToken = await getNewTokenForAccount(account);
                if (!currentToken) throw new Error("Gagal login ulang, skip akun.");
                let currentConfig = await readConfig();
                currentConfig.accounts[i].authToken = currentToken;
                await writeConfig(currentConfig);
                result = await checkTokenAndFetchPolls(currentToken, channelId);
            }

            if (result.status === 'success' && result.data) {
                console.log('✅ Token valid. Memeriksa polls...');
                let unvotedPollsFound = 0;
                for (const message of result.data) {
                    if (message.poll) {
                        const hasVoted = message.poll.results.answer_counts.some(answer => answer.me_voted);
                        if (!hasVoted) {
                            unvotedPollsFound++;
                            await voteOnPoll(currentToken, account, message, whatsappClient);
                            await delay(3000);
                        }
                    }
                }
                if (unvotedPollsFound === 0) console.log('👍 Semua poll sudah di-vote.');
            } else {
                throw new Error(`Gagal memproses API: ${result.data}`);
            }
        } catch (error) {
            console.error(`❌ Gagal memproses sub-siklus untuk akun ${account.accountName}: ${error.message}`);
        }
        await delay(5000); // Jeda antar akun
    }
}

// --- FUNGSI MAIN() YANG MENGATUR JADWAL & PILIHAN ---
async function main() {
    console.clear();
    console.log('====================================================');
    console.log('          SELAMAT DATANG DI BOT DISCORD VOTER         ');
    console.log('====================================================');
    console.log('\nPERINGATAN PENTING:');
    console.log('Untuk notifikasi WhatsApp, sangat disarankan menggunakan nomor BARU');
    console.log('atau nomor sekunder (nomor bot), BUKAN nomor pribadi Anda.');
    console.log('Ini untuk menghindari risiko pemblokiran pada nomor utama Anda.\n');

    const choice = await askQuestion('--> Apakah Anda ingin menjalankan bot dengan notifikasi WhatsApp? (y/n): ');
    const withWhatsApp = choice === 'y';

    const intervalHours = 5;
    const intervalInMs = intervalHours * 60 * 60 * 1000;

    if (withWhatsApp) {
        console.log('\nOke, bot akan berjalan dengan notifikasi WhatsApp (mode On-Demand).');
    } else {
        console.log('\nOke, bot akan berjalan TANPA notifikasi WhatsApp.');
    }
    console.log(`Siklus pengecekan akan berjalan setiap ${intervalHours} jam.`);

    while (true) {
        console.log(`\n\n--- MEMULAI SIKLUS PENGECEKAN BARU --- (${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}) ---`);
        let whatsappClient = null;

        const config = await readConfig(); // Baca config di dalam fungsi
        const isHeadless = config.display !== 'on'; // Headless jika display BUKAN 'on'
        try {
            if (withWhatsApp) {
                const config = await readConfig();
                whatsappClient = new Client({
                    authStrategy: new LocalAuth({ dataPath: config.whatsappSessionPath }),
                    puppeteer: {
                        headless: isHeadless,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu']
                    }
                });
                await initializeWhatsApp(whatsappClient);
            }

            // Jalankan siklus discord, kirim client WA (atau null jika tidak aktif)
            await runDiscordCycle(whatsappClient);

        } catch (error) {
            console.error("❌ Terjadi kesalahan besar dalam siklus ini:", error.message);
        } finally {
            if (whatsappClient) {
                console.log("\nMematikan client WhatsApp untuk menghemat sumber daya...");
                await whatsappClient.destroy();
                console.log("Client WhatsApp berhasil dimatikan.");
            }
        }

        console.log(`\n--- SIKLUS SELESAI. Bot akan tidur selama ${intervalHours} jam. ---`);
        await delay(intervalInMs);
    }
}

// Jalankan bot
main().catch(err => {
    console.error("FATAL ERROR, bot berhenti:", err);
    process.exit(1);
});