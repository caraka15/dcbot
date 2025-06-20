// --- DEPENDENCIES ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { authenticator } = require('otplib');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_PATH = path.resolve(__dirname, 'config.json');
const POLL_DATA_PATH = path.resolve(__dirname, 'poll_data.json'); // Path untuk menyimpan data poll

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

// --- FUNGSI MANAJEMEN DATA POLL ---
async function readPollData() {
    try {
        const data = await fs.readFile(POLL_DATA_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                lastUpdated: new Date().toISOString(),
                polls: {}
            };
        }
        console.error("❌ Error membaca poll_data.json:", error.message);
        return {
            lastUpdated: new Date().toISOString(),
            polls: {}
        };
    }
}

async function writePollData(data) {
    try {
        data.lastUpdated = new Date().toISOString();
        await fs.writeFile(POLL_DATA_PATH, JSON.stringify(data, null, 4), 'utf-8');
    } catch (error) {
        console.error("❌ Error menulis poll_data.json:", error.message);
    }
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
async function fetchChannelMessages(token, channelId) {
    const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=50`;
    const headers = { "Authorization": token, "User-Agent": "Mozilla/5.0" };
    try {
        const response = await fetch(url, { headers });
        if (response.status === 401) return { status: 'unauthorized' };
        if (!response.ok) throw new Error(`Status: ${response.status} - ${await response.text()}`);
        return { status: 'success', data: await response.json() };
    } catch (error) {
        return { status: 'error', data: error.message };
    }
}

// =========================================================
// PERBAIKAN getPollVotes untuk menangani pagination
// =========================================================
async function getPollVotes(token, channelId, messageId, answerId) {
    let allUsers = [];
    let lastUserId = null;
    const limit = 100; // Maksimal user per halaman

    while (true) {
        let url = `https://discord.com/api/v9/channels/${channelId}/polls/${messageId}/answers/${answerId}?limit=${limit}&type=2`;
        if (lastUserId) {
            url += `&after=${lastUserId}`;
        }

        const headers = { "Authorization": token, "User-Agent": "Mozilla/5.0" };
        try {
            const response = await fetch(url, { headers });
            if (!response.ok) {
                console.warn(`   - Gagal mengambil halaman voter untuk poll ${messageId}, jawaban ${answerId}. Status: ${response.status}`);
                return null; // Mengembalikan null jika ada masalah di tengah jalan
            }
            const data = await response.json();

            if (!data || !data.users || data.users.length === 0) {
                break; // Tidak ada user lagi, keluar dari loop
            }

            allUsers = allUsers.concat(data.users);
            lastUserId = data.users[data.users.length - 1].id; // Ambil ID user terakhir untuk halaman berikutnya

            // Jika jumlah user yang diterima kurang dari limit, berarti ini halaman terakhir
            if (data.users.length < limit) {
                break;
            }
            await delay(500); // Jeda antar halaman untuk menghindari rate limiting
        } catch (error) {
            console.error(`   - Error saat mengambil halaman voter: ${error.message}`);
            return null;
        }
    }
    return { users: allUsers };
}

async function voteOnPoll(token, account, message, chosenAnswerId, chosenAnswerText, questionText, whatsappClient) {
    console.log(`🗳️  Memilih jawaban #${chosenAnswerId} ("${chosenAnswerText}") untuk poll: "${questionText}"`);
    const url = `https://discord.com/api/v9/channels/${message.channel_id}/polls/${message.id}/answers/@me`;
    const headers = { "Authorization": token, "User-Agent": "Mozilla/5.0", "Content-Type": "application/json" };
    const body = JSON.stringify({ "answer_ids": [chosenAnswerId.toString()] });

    try {
        const response = await fetch(url, { method: 'PUT', headers, body });
        if (response.status === 204) {
            console.log(`✅ Vote berhasil untuk ${account.accountName}!`);
            if (whatsappClient && account.whatsappNumber) {
                const chatId = `${account.whatsappNumber}@c.us`;
                const notificationMessage = `*Vote Berhasil Terkirim!* 🗳️\n\n*Akun:*\n${account.accountName}\n\n*Pertanyaan:*\n${questionText}\n\n*Jawaban Anda (pilihan terbanyak):*\n${chosenAnswerText}`;
                try {
                    await whatsappClient.sendMessage(chatId, notificationMessage);
                    console.log(`📱 Notifikasi WhatsApp terkirim ke ${account.whatsappNumber}`);
                } catch (waErr) {
                    console.error(`❌ Gagal mengirim notifikasi WA ke ${account.whatsappNumber}:`, waErr.message);
                }
            }
            return true; // Vote berhasil
        } else {
            console.error(`❌ Gagal vote untuk ${account.accountName}, status: ${response.status}`, await response.text());
            return false; // Vote gagal
        }
    } catch (error) {
        console.error(`❌ Terjadi error saat melakukan vote untuk ${account.accountName}:`, error);
        return false; // Vote gagal
    }
}

async function getNewTokenForAccount(accountConfig) {
    console.log(`🤖 Menjalankan fungsi login ulang untuk ${accountConfig.accountName}...`);
    let browser;
    let newToken = null;
    try {
        const userDataDir = path.resolve(__dirname, accountConfig.userDataDir);
        console.log(`Membersihkan sesi lama di: ${userDataDir}`);
        if (fsSync.existsSync(userDataDir)) await fs.rm(userDataDir, { recursive: true, force: true });
        await fs.mkdir(userDataDir, { recursive: true });

        const config = await readConfig();
        const isHeadless = (config.display === 'on') ? false : true;
        browser = await puppeteer.launch({ headless: isHeadless, args: ['--no-sandbox', '--disable-gpu'] });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const headers = request.headers();
            if (headers.authorization && !newToken) {
                newToken = headers.authorization;
            }
            if (!request.isInterceptResolutionHandled()) request.continue();
        });

        await page.goto("https://discord.com/login", { waitUntil: 'networkidle2' });
        await page.type('input[name="email"]', accountConfig.email, { delay: 50 });
        await page.type('input[name="password"]', accountConfig.password, { delay: 50 });
        await page.click('button[type="submit"]');

        try {
            await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: 15000 });
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
        console.error(`❌ Error besar saat login ulang untuk ${accountConfig.accountName}: ${error.message}`);
        if (browser) await browser.close();
        return null;
    }
}

// =================================================================
// --- FUNGSI SIKLUS UTAMA ---
// =================================================================

async function runDiscordCycle(whatsappClient) {
    const config = await readConfig();
    const channelIdParts = config.pollChannelUrl.split('/');
    const channelId = channelIdParts.pop() || channelIdParts.pop();
    console.log(`🎯 Channel ID target diatur ke: ${channelId}`);

    let allPollsDataFromAPI = []; // Data poll mentah dari API (dengan token awal)
    let validInitialToken = null; // Token yang digunakan untuk mengambil daftar poll global
    let storedPollData = await readPollData(); // Membaca data poll yang tersimpan

    // --- Mencari token valid dari salah satu akun untuk panggilan API awal ---
    if (config.accounts.length === 0) {
        console.error("❌ Tidak ada akun yang dikonfigurasi. Mohon tambahkan akun di config.json.");
        return;
    }

    for (let i = 0; i < config.accounts.length; i++) {
        let account = config.accounts[i];
        console.log(`\n🔍 Mencoba validasi token dari akun: ${account.accountName}`);
        let currentToken = account.authToken;

        if (!currentToken) {
            console.warn(`  ⚠️ Token kosong, mencoba login untuk ${account.accountName}...`);
            currentToken = await getNewTokenForAccount(account);
            if (currentToken) {
                config.accounts[i].authToken = currentToken;
                await writeConfig(config);
            } else {
                console.error(`  ❌ Gagal mendapatkan token untuk ${account.accountName}. Melewatkan akun ini.`);
                continue;
            }
        }

        if (currentToken) {
            const testFetchResult = await fetchChannelMessages(currentToken, channelId);
            if (testFetchResult.status === 'success') {
                validInitialToken = currentToken;
                allPollsDataFromAPI = testFetchResult.data.filter(message => message.poll);
                console.log(`  ✅ Token dari ${account.accountName} valid. Ditemukan ${allPollsDataFromAPI.length} poll dari API.`);
                break;
            } else if (testFetchResult.status === 'unauthorized') {
                console.warn(`  ❌ Token dari ${account.accountName} tidak valid (unauthorized). Mencoba login ulang...`);
                currentToken = await getNewTokenForAccount(account);
                if (currentToken) {
                    config.accounts[i].authToken = currentToken;
                    await writeConfig(config);
                    const reTestFetchResult = await fetchChannelMessages(currentToken, channelId);
                    if (reTestFetchResult.status === 'success') {
                        validInitialToken = currentToken;
                        allPollsDataFromAPI = reTestFetchResult.data.filter(message => message.poll);
                        console.log(`  ✅ Token baru dari ${account.accountName} valid. Ditemukan ${allPollsDataFromAPI.length} poll dari API.`);
                        break;
                    } else {
                        console.error(`  ❌ Token baru dari ${account.accountName} juga tidak valid. Melewatkan akun ini.`);
                    }
                } else {
                    console.error(`  ❌ Gagal login ulang untuk ${account.accountName}. Melewatkan akun ini.`);
                }
            } else {
                console.error(`  ⚠️ Gagal memvalidasi token ${account.accountName}: ${testFetchResult.data}. Melewatkan akun ini.`);
            }
        }
    }

    if (!validInitialToken) {
        console.error("❌ Tidak ada token akun yang valid ditemukan setelah mencoba semua akun. Tidak bisa mengambil daftar poll. Siklus berhenti.");
        return;
    }

    // --- Cek apakah ada poll baru yang belum ada di penyimpanan lokal ---
    let newPollsFound = 0;
    const currentPollIds = new Set(Object.keys(storedPollData.polls));
    const apiPollIds = new Set(allPollsDataFromAPI.map(p => p.id));

    // Hitung poll baru
    for (const apiPollId of apiPollIds) {
        if (!currentPollIds.has(apiPollId)) {
            newPollsFound++;
        }
    }

    // --- Jika tidak ada poll baru, update status 'ended_at' untuk poll yang sudah ada, lalu berhenti ---
    if (newPollsFound === 0) {
        console.log(`\n--- 👍 Tidak ada poll baru yang terdeteksi. Hanya memperbarui status berakhir untuk poll yang sudah ada. ---`);
        const now = new Date();
        for (const apiPoll of allPollsDataFromAPI) {
            const pollId = apiPoll.id;
            const storedPoll = storedPollData.polls[pollId];
            if (storedPoll) { // Jika poll sudah ada di penyimpanan lokal
                const currentApiEndedAt = apiPoll.poll.results?.ended_at || null;
                const isEndedNow = currentApiEndedAt ? (new Date(currentApiEndedAt) <= now) : false;

                if (storedPoll.ended_at !== currentApiEndedAt) {
                    storedPoll.ended_at = currentApiEndedAt;
                    console.log(`  [INFO] Status berakhir poll "${apiPoll.poll.question.text}" (ID: ${pollId}) telah diperbarui.`);
                }
                // Update loggedEnded juga jika statusnya berubah ke ended
                if (!storedPoll.loggedEnded && isEndedNow) {
                    console.log(`  [INFO] Poll "${apiPoll.poll.question.text}" (ID: ${pollId}) kini sudah berakhir.`);
                    storedPoll.loggedEnded = true;
                }
            }
        }
        await writePollData(storedPollData); // Simpan perubahan status ended_at
        console.log("✅ Data poll terbaru (status berakhir) telah disimpan ke poll_data.json.");
        return; // Hentikan seluruh fungsi runDiscordCycle di sini
    } else {
        console.log(`\n--- Ditemukan ${newPollsFound} poll baru. Melanjutkan siklus voting. ---`);
    }

    // --- Update storedPollData dengan data terbaru dari API dan detail voter ---
    const now = new Date();
    const activePollIdsToProcess = new Set(); // Hanya simpan ID poll yang aktif

    for (const apiPoll of allPollsDataFromAPI) {
        const pollId = apiPoll.id;
        let isEnded = false;
        if (apiPoll.poll.results && apiPoll.poll.results.ended_at) {
            const endedAt = new Date(apiPoll.poll.results.ended_at);
            if (endedAt <= now) {
                isEnded = true;
            }
        }

        // Tentukan pilihan terbanyak secara global dari data API ini
        let mostVotedAnswerId = null;
        let maxVotes = -1;
        let mostVotedAnswerText = '';

        if (apiPoll.poll.results && apiPoll.poll.results.answer_counts) {
            for (const answerCount of apiPoll.poll.results.answer_counts) {
                if (answerCount.total > maxVotes) {
                    maxVotes = answerCount.total;
                    mostVotedAnswerId = answerCount.id;
                    const fullAnswer = apiPoll.poll.answers.find(ans => ans.answer_id === answerCount.id);
                    if (fullAnswer) {
                        mostVotedAnswerText = fullAnswer.poll_media.text;
                    }
                }
            }
        }

        // Inisialisasi atau update struktur poll di storedPollData
        if (!storedPollData.polls[pollId]) {
            storedPollData.polls[pollId] = {
                question: apiPoll.poll.question.text,
                answers: {}, // Akan diisi di bawah
                expiry: apiPoll.poll.expiry || null,
                ended_at: apiPoll.poll.results ? apiPoll.poll.results.ended_at : null,
                mostVotedAnswerId: mostVotedAnswerId,
                mostVotedAnswerText: mostVotedAnswerText,
                loggedEnded: isEnded
            };
        } else {
            // Update metadata poll jika ada perubahan
            storedPollData.polls[pollId].question = apiPoll.poll.question.text;
            storedPollData.polls[pollId].expiry = apiPoll.poll.expiry || null;
            if (apiPoll.poll.results && apiPoll.poll.results.ended_at) {
                storedPollData.polls[pollId].ended_at = apiPoll.poll.results.ended_at;
            }
            storedPollData.polls[pollId].mostVotedAnswerId = mostVotedAnswerId;
            storedPollData.polls[pollId].mostVotedAnswerText = mostVotedAnswerText;

            if (!storedPollData.polls[pollId].loggedEnded && isEnded) {
                console.log(`  [INFO] Poll "${apiPoll.poll.question.text}" (ID: ${pollId}) sudah berakhir.`);
                storedPollData.polls[pollId].loggedEnded = true;
            }
        }

        // --- Panggil getPollVotes untuk setiap pilihan jawaban untuk mendapatkan SEMUA voter ---
        // Ini akan dilakukan hanya sekali per siklus untuk setiap poll
        for (const answer of apiPoll.poll.answers) {
            const answerId = answer.answer_id;
            const answerText = answer.poll_media.text;

            // Pastikan struktur jawaban ada
            if (!storedPollData.polls[pollId].answers[answerId]) {
                storedPollData.polls[pollId].answers[answerId] = {
                    text: answerText,
                    totalCount: 0,
                    voters: [] // Ini akan menyimpan semua username voter
                };
            }

            console.log(`  - Mengambil voter untuk poll "${apiPoll.poll.question.text}", jawaban "${answerText}"`);
            const votesData = await getPollVotes(validInitialToken, channelId, pollId, answerId);

            if (votesData && votesData.users) {
                const apiAnswerCount = apiPoll.poll.results?.answer_counts.find(ac => ac.id === answerId)?.total || 0;
                storedPollData.polls[pollId].answers[answerId].totalCount = apiAnswerCount;
                // Hanya simpan username, pastikan unik
                storedPollData.polls[pollId].answers[answerId].voters = [...new Set(votesData.users.map(u => u.username))];
                console.log(`    Ditemukan total ${votesData.users.length} voter.`);
            } else {
                storedPollData.polls[pollId].answers[answerId].totalCount = 0;
                storedPollData.polls[pollId].answers[answerId].voters = [];
                console.log(`    Tidak ada voter atau gagal mengambil data.`);
            }
            await delay(500); // Jeda kecil antar panggilan getPollVotes
        }

        // Hanya tambahkan ke daftar proses jika belum berakhir
        if (!isEnded) {
            activePollIdsToProcess.add(pollId);
        }
    }

    // --- Siklus pemrosesan untuk setiap akun (menggunakan data dari storedPollData) ---
    for (let i = 0; i < config.accounts.length; i++) {
        let account = config.accounts[i];
        console.log(`\n--- Memproses Akun: ${account.accountName} ---`);

        // Pastikan akun memiliki username di config
        if (!account.username) {
            console.warn(`  [SKIP] Akun ${account.accountName} tidak memiliki 'username' di config. Lewati pengecekan vote.`);
            continue; // Lanjutkan ke akun berikutnya
        }

        let currentToken = account.authToken;
        if (!currentToken) {
            console.warn(`⚠️ Token kosong untuk ${account.accountName}, mencoba login ulang...`);
            currentToken = await getNewTokenForAccount(account);
            if (!currentToken) {
                console.error(`❌ Gagal mendapatkan token baru untuk ${account.accountName}, skip akun ini.`);
                continue;
            }
            config.accounts[i].authToken = currentToken;
            await writeConfig(config);
        }

        let unvotedPollsFoundForAccount = 0;
        for (const pollId of activePollIdsToProcess) {
            const storedPoll = storedPollData.polls[pollId];
            if (!storedPoll) {
                console.warn(`  [WARN] Poll ID ${pollId} tidak ditemukan di data tersimpan meskipun seharusnya aktif. Melewatkan.`);
                continue;
            }
            const questionText = storedPoll.question;
            const mostVotedAnswerId = storedPoll.mostVotedAnswerId;
            const mostVotedAnswerText = storedPoll.mostVotedAnswerText;

            let hasVoted = false;
            let votedOnMostVoted = false; // Menandakan apakah sudah vote pada pilihan terbanyak
            let currentVotedAnswerText = "Tidak Diketahui";

            // Cek apakah username akun ini ada di daftar voter untuk pilihan manapun
            for (const answerId in storedPoll.answers) {
                if (storedPoll.answers[answerId].voters.includes(account.username)) {
                    hasVoted = true;
                    currentVotedAnswerText = storedPoll.answers[answerId].text;
                    if (parseInt(answerId) === mostVotedAnswerId) { // Perbandingan ID harus aman (number vs string)
                        votedOnMostVoted = true;
                    }
                    break;
                }
            }

            console.log(`  > Memeriksa Poll: "${questionText}" (ID: ${pollId})`);

            if (hasVoted) {
                if (votedOnMostVoted) {
                    console.log(`    ✅ Akun ${account.accountName} SUDAH vote pada poll ini, dengan pilihan terbanyak: "${mostVotedAnswerText}".`);
                } else {
                    console.log(`    ⚠️ Akun ${account.accountName} SUDAH vote pada poll ini, tetapi BUKAN pilihan terbanyak (vote: "${currentVotedAnswerText}").`);
                }
            } else {
                unvotedPollsFoundForAccount++;
                console.log(`    ⏳ Akun ${account.accountName} BELUM vote pada poll ini. Akan melakukan voting dengan pilihan terbanyak.`);

                if (mostVotedAnswerId !== null) {
                    console.log(`    ⭐ Pilihan terbanyak (global): "${mostVotedAnswerText}" (${mostVotedAnswerId}).`);
                    const voteSuccess = await voteOnPoll(currentToken, account, storedPoll, mostVotedAnswerId, mostVotedAnswerText, questionText, whatsappClient);

                    if (voteSuccess) {
                        // Perbarui status vote di storedPollData setelah vote berhasil
                        if (storedPoll.answers[mostVotedAnswerId]) {
                            // Tambahkan username ke daftar voter untuk opsi yang divote
                            if (!storedPoll.answers[mostVotedAnswerId].voters.includes(account.username)) {
                                storedPoll.answers[mostVotedAnswerId].voters.push(account.username);
                            }
                            storedPoll.answers[mostVotedAnswerId].totalCount++; // Tambah total count juga
                        }
                    }
                    await delay(3000); // Jeda setelah vote
                } else {
                    console.warn(`    ⚠️ Tidak dapat menentukan pilihan terbanyak untuk poll ini. Melewatkan vote.`);
                }
            }
            await delay(1000); // Jeda antar pengecekan poll untuk akun yang sama
        }
        if (unvotedPollsFoundForAccount === 0 && activePollIdsToProcess.size > 0) {
            console.log(`  👍 Semua poll aktif sudah di-vote oleh ${account.accountName}.`);
        } else if (activePollIdsToProcess.size === 0) {
            console.log(`  [INFO] Tidak ada poll aktif untuk diproses oleh ${account.accountName}.`);
        }
        await delay(5000); // Jeda antar akun
    }
    console.log('\n--- Semua akun dan poll selesai diproses ---');

    // Simpan data poll yang diperbarui
    await writePollData(storedPollData);
    console.log("✅ Data poll terbaru telah disimpan ke poll_data.json.");
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

        try {
            if (withWhatsApp) {
                const config = await readConfig();
                const isHeadless = (config.display === 'on') ? false : true;
                whatsappClient = new Client({
                    authStrategy: new LocalAuth({ dataPath: config.whatsappSessionPath }),
                    puppeteer: {
                        headless: isHeadless,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu']
                    }
                });
                await initializeWhatsApp(whatsappClient);
            }

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