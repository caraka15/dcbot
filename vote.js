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

async function voteOnPoll(token, account, message, chosenAnswerId, chosenAnswerText, questionText) {
    console.log(`🗳️  Memilih jawaban #${chosenAnswerId} ("${chosenAnswerText}") untuk poll: "${questionText}"`);
    const url = `https://discord.com/api/v9/channels/${message.channel_id}/polls/${message.id}/answers/@me`;
    const headers = { "Authorization": token, "User-Agent": "Mozilla/5.0", "Content-Type": "application/json" };
    const body = JSON.stringify({ "answer_ids": [chosenAnswerId.toString()] });

    try {
        const response = await fetch(url, { method: 'PUT', headers, body });
        if (response.status === 204) {
            console.log(`✅ Vote berhasil untuk ${account.accountName}!`);
            return true;
        } else {
            console.error(`❌ Gagal vote untuk ${account.accountName}, status: ${response.status}`, await response.text());
            return false;
        }
    } catch (error) {
        console.error(`❌ Terjadi error saat melakukan vote untuk ${account.accountName}:`, error);
        return false;
    }
}

async function getNewTokenForAccount(accountConfig) {
    console.log(`🤖 Menjalankan fungsi login ulang untuk ${accountConfig.accountName}...`);
    let browser;
    let newToken = null;
    try {
        const userDataDir = path.resolve(__dirname, accountConfig.userDataDir);
        console.log(`Membersihkan sesi lama di: ${userDataDir}`);
        if (fsSync.existsSync(userDataDir)) await fs.rm(userDataDir, { recursive: true, true: true }); // fixed true:true to force:true
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

    let allPollsDataFromAPI = [];
    let validInitialToken = null;
    let storedPollData = await readPollData(); // Load initial data from disk

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
            if (storedPoll) {
                const currentApiEndedAt = apiPoll.poll.results?.ended_at || null;
                const isEndedNow = currentApiEndedAt ? (new Date(currentApiEndedAt) <= now) : false;

                if (storedPoll.ended_at !== currentApiEndedAt) {
                    storedPoll.ended_at = currentApiEndedAt;
                    console.log(`  [INFO] Status berakhir poll "${apiPoll.poll.question.text}" (ID: ${pollId}) telah diperbarui.`);
                }
                if (!storedPoll.loggedEnded && isEndedNow) {
                    console.log(`  [INFO] Poll "${apiPoll.poll.question.text}" (ID: ${pollId}) kini sudah berakhir.`);
                    storedPoll.loggedEnded = true;
                }
            }
        }
        await writePollData(storedPollData);
        console.log("✅ Data poll terbaru (status berakhir) telah disimpan ke poll_data.json.");
        return; // Hentikan seluruh fungsi runDiscordCycle di sini
    } else {
        console.log(`\n--- Ditemukan ${newPollsFound} poll baru. Melanjutkan siklus voting. ---`);
    }

    // --- Update storedPollData dengan data terbaru dari API dan detail voter ---
    const now = new Date();
    const activePollIdsToProcess = new Set();

    for (const apiPoll of allPollsDataFromAPI) {
        const pollId = apiPoll.id;
        let isEnded = false;
        if (apiPoll.poll.results && apiPoll.poll.results.ended_at) {
            const endedAt = new Date(apiPoll.poll.results.ended_at);
            if (endedAt <= now) {
                isEnded = true;
            }
        }

        let mostVotedAnswerId = null;
        let mostVotedAnswerText = '';

        if (apiPoll.poll.results && apiPoll.poll.results.answer_counts && apiPoll.poll.answers) {
            // Find the answerCount object with the maximum count
            const topAnswerCount = apiPoll.poll.results.answer_counts.reduce((max, current) => {
                return (current.count > max.count) ? current : max;
            }, { count: -1 }); // Initialize with a count less than any possible vote

            if (topAnswerCount.id !== undefined && topAnswerCount.count > -1) { // Ensure a valid top answer was found
                mostVotedAnswerId = topAnswerCount.id;
                // Find the corresponding answer text from apiPoll.poll.answers
                const fullAnswer = apiPoll.poll.answers.find(ans => ans.answer_id === topAnswerCount.id);
                if (fullAnswer) {
                    mostVotedAnswerText = fullAnswer.poll_media.text;
                }
            }
        }

        if (!storedPollData.polls[pollId]) {
            storedPollData.polls[pollId] = {
                question: apiPoll.poll.question.text,
                answers: {},
                expiry: apiPoll.poll.expiry || null,
                ended_at: apiPoll.poll.results ? apiPoll.poll.results.ended_at : null,
                bigVoter: mostVotedAnswerId, // ADDED: bigVoter property
                mostVotedAnswerText: mostVotedAnswerText,
                loggedEnded: isEnded
            };
        } else {
            storedPollData.polls[pollId].question = apiPoll.poll.question.text;
            storedPollData.polls[pollId].expiry = apiPoll.poll.expiry || null;
            if (apiPoll.poll.results && apiPoll.poll.results.ended_at) {
                storedPollData.polls[pollId].ended_at = apiPoll.poll.results.ended_at;
            }
            storedPollData.polls[pollId].bigVoter = mostVotedAnswerId; // UPDATED: bigVoter
            storedPollData.polls[pollId].mostVotedAnswerText = mostVotedAnswerText;

            if (!storedPollData.polls[pollId].loggedEnded && isEnded) {
                console.log(`  [INFO] Poll "${apiPoll.poll.question.text}" (ID: ${pollId}) sudah berakhir.`);
                storedPollData.polls[pollId].loggedEnded = true;
            }
        }

        for (const answer of apiPoll.poll.answers) {
            const answerId = answer.answer_id;
            const answerText = answer.poll_media.text;

            if (!storedPollData.polls[pollId].answers[answerId]) {
                storedPollData.polls[pollId].answers[answerId] = {
                    text: answerText,
                    totalCount: 0,
                    voters: []
                };
            }

            console.log(`  - Mengambil voter untuk poll "${apiPoll.poll.question.text}", jawaban "${answerText}"`);
            const votesData = await getPollVotes(validInitialToken, channelId, pollId, answerId);

            if (votesData && votesData.users) {
                storedPollData.polls[pollId].answers[answerId].totalCount = votesData.users.length;
                storedPollData.polls[pollId].answers[answerId].voters = [...new Set(votesData.users.map(u => u.username))];
                console.log(`    Ditemukan total ${votesData.users.length} voter.`);
            } else {
                storedPollData.polls[pollId].answers[answerId].totalCount = 0;
                storedPollData.polls[pollId].answers[answerId].voters = [];
                console.log(`    Tidak ada voter atau gagal mengambil data.`);
            }
            await delay(500);
        }

        if (!isEnded) {
            activePollIdsToProcess.add(pollId);
        }
    }

    // --- PENTING: Simpan data poll yang sudah diperbarui ke file di sini ---
    await writePollData(storedPollData);
    console.log("✅ Data poll terbaru (termasuk totalCount, voters, dan bigVoter) telah disimpan ke poll_data.json.");

    // --- MUAT ULANG storedPollData dari file untuk memastikan data yang paling akurat ---
    storedPollData = await readPollData();
    console.log("🔄 Data poll dimuat ulang dari file untuk memastikan konsistensi sebelum memproses akun.");

    // Initialize cycleSummary here to collect results for the WA admin message
    const cycleSummary = {
        totalAccounts: config.accounts.length,
        accountsVoted: [],
        accountsAlreadyVoted: [],
        accountsAlreadyVotedNotMostPopular: [],
        accountsSkipped: [],
        accountsFailedToVote: [],
        accountsTokenFailed: []
    };

    for (let i = 0; i < config.accounts.length; i++) {
        let account = config.accounts[i];
        console.log(`\n--- Memproses Akun: ${account.accountName} ---`);

        if (!account.username) {
            console.warn(`  [SKIP] Akun ${account.accountName} tidak memiliki 'username' di config. Lewati pengecekan vote.`);
            cycleSummary.accountsSkipped.push({ name: account.accountName, reason: "No username in config" });
            continue;
        }

        let currentToken = account.authToken;
        if (!currentToken) {
            console.warn(`⚠️ Token kosong untuk ${account.accountName}, mencoba login ulang...`);
            currentToken = await getNewTokenForAccount(account);
            if (!currentToken) {
                console.error(`❌ Gagal mendapatkan token baru untuk ${account.accountName}, skip akun ini.`);
                cycleSummary.accountsTokenFailed.push({ name: account.accountName, reason: "Failed to get new token" });
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
            const mostVotedAnswerId = storedPoll.bigVoter; // Using bigVoter directly
            const mostVotedAnswerText = storedPoll.mostVotedAnswerText;

            let hasVoted = false;
            let votedOnMostVoted = false;
            let currentVotedAnswerText = "Tidak Diketahui";

            for (const answerId in storedPoll.answers) {
                if (storedPoll.answers[answerId].voters.includes(account.username)) {
                    hasVoted = true;
                    currentVotedAnswerText = storedPoll.answers[answerId].text;
                    if (parseInt(answerId) === mostVotedAnswerId) { // Compare against bigVoter
                        votedOnMostVoted = true;
                    }
                    break;
                }
            }

            console.log(`  > Memeriksa Poll: "${questionText}" (ID: ${pollId})`);

            if (hasVoted) {
                if (votedOnMostVoted) {
                    console.log(`    ✅ Akun ${account.accountName} SUDAH vote pada poll ini, dengan pilihan terbanyak: "${mostVotedAnswerText}".`);
                    if (!cycleSummary.accountsAlreadyVoted.includes(account.accountName) && !cycleSummary.accountsAlreadyVotedNotMostPopular.includes(account.accountName)) {
                        cycleSummary.accountsAlreadyVoted.push(account.accountName);
                    }
                } else {
                    console.log(`    ⚠️ Akun ${account.accountName} SUDAH vote pada poll ini, tetapi BUKAN pilihan terbanyak (vote: "${currentVotedAnswerText}").`);
                    if (!cycleSummary.accountsAlreadyVoted.includes(account.accountName) && !cycleSummary.accountsAlreadyVotedNotMostPopular.includes(account.accountName)) {
                        cycleSummary.accountsAlreadyVotedNotMostPopular.push(account.accountName);
                    }
                }
            } else {
                unvotedPollsFoundForAccount++;
                console.log(`    ⏳ Akun ${account.accountName} BELUM vote pada poll ini. Akan melakukan voting dengan pilihan terbanyak.`);

                if (mostVotedAnswerId !== null) {
                    console.log(`    ⭐ Pilihan terbanyak (global): "${mostVotedAnswerText}" (${mostVotedAnswerId}).`);
                    const voteSuccess = await voteOnPoll(currentToken, account, storedPoll, mostVotedAnswerId, mostVotedAnswerText, questionText);

                    if (voteSuccess) {
                        if (storedPoll.answers[mostVotedAnswerId]) {
                            if (!storedPoll.answers[mostVotedAnswerId].voters.includes(account.username)) {
                                storedPoll.answers[mostVotedAnswerId].voters.push(account.username);
                            }
                            storedPoll.answers[mostVotedAnswerId].totalCount++;
                        }
                        if (!cycleSummary.accountsVoted.includes(account.accountName)) {
                            cycleSummary.accountsVoted.push(account.accountName);
                        }
                    } else {
                        cycleSummary.accountsFailedToVote.push({ name: account.accountName, poll: questionText, reason: "API vote failed" });
                    }
                    await delay(3000);
                } else {
                    console.warn(`    ⚠️ Tidak dapat menentukan pilihan terbanyak untuk poll ini. Melewatkan vote.`);
                    cycleSummary.accountsFailedToVote.push({ name: account.accountName, poll: questionText, reason: "No most voted answer found" });
                }
            }
            await delay(1000);
        }
        if (unvotedPollsFoundForAccount === 0 && activePollIdsToProcess.size > 0) {
            console.log(`  👍 Semua poll aktif sudah di-vote oleh ${account.accountName}.`);
        } else if (activePollIdsToProcess.size === 0) {
            console.log(`  [INFO] Tidak ada poll aktif untuk diproses oleh ${account.accountName}.`);
        }
        await delay(5000);
    }
    console.log('\n--- Semua akun dan poll selesai diproses ---');

    // Simpan lagi di akhir siklus untuk memastikan setiap perubahan akibat voting juga tersimpan
    await writePollData(storedPollData);
    console.log("✅ Data poll terbaru (setelah pemrosesan akun) telah disimpan ke poll_data.json.");

    // --- Kirim Ringkasan ke WhatsApp Admin ---
    if (whatsappClient && config.wa_admin) {
        const adminChatId = `${config.wa_admin}@c.us`;
        let summaryMessage = `*Ringkasan Siklus Bot Discord Voter (${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })})*\n\n`;

        if (newPollsFound === 0 && activePollIdsToProcess.size === 0) {
            summaryMessage += `Tidak ada poll aktif baru yang terdeteksi atau perlu divote.`;
        } else {
            const uniqueVoted = [...new Set(cycleSummary.accountsVoted)];
            const uniqueAlreadyVoted = [...new Set(cycleSummary.accountsAlreadyVoted)];
            const uniqueAlreadyVotedNotMostPopular = [...new Set(cycleSummary.accountsAlreadyVotedNotMostPopular)];
            const uniqueFailedToVote = [...new Set(cycleSummary.accountsFailedToVote.map(f => f.name))];
            const uniqueSkipped = [...new Set(cycleSummary.accountsSkipped.map(s => s.name))];
            const uniqueTokenFailed = [...new Set(cycleSummary.accountsTokenFailed.map(t => t.name))];

            summaryMessage += `*Status Akun (${config.accounts.length} Total Akun)*:\n`;

            summaryMessage += `✅ *Berhasil Vote Baru:* (${uniqueVoted.length})\n`;
            if (uniqueVoted.length > 0) {
                summaryMessage += uniqueVoted.map(name => `- ${name}`).join('\n') + '\n\n';
            } else {
                summaryMessage += `- Tidak ada\n\n`;
            }

            summaryMessage += `👍 *Sudah Vote (Pilihan Terbanyak):* (${uniqueAlreadyVoted.length})\n`;
            if (uniqueAlreadyVoted.length > 0) {
                summaryMessage += uniqueAlreadyVoted.map(name => `- ${name}`).join('\n') + '\n\n';
            } else {
                summaryMessage += `- Tidak ada\n\n`;
            }

            summaryMessage += `⚠️ *Sudah Vote (Bukan Pilihan Terbanyak):* (${uniqueAlreadyVotedNotMostPopular.length})\n`;
            if (uniqueAlreadyVotedNotMostPopular.length > 0) {
                summaryMessage += uniqueAlreadyVotedNotMostPopular.map(name => `- ${name}`).join('\n') + '\n\n';
            } else {
                summaryMessage += `- Tidak ada\n\n`;
            }

            summaryMessage += `❌ *Gagal Vote:* (${uniqueFailedToVote.length})\n`;
            if (uniqueFailedToVote.length > 0) {
                const failedDetails = cycleSummary.accountsFailedToVote
                    .map(item => `- ${item.name} (Poll: "${item.poll}", Sebab: ${item.reason || 'Tidak diketahui'})`)
                    .join('\n');
                summaryMessage += failedDetails + '\n\n';
            } else {
                summaryMessage += `- Tidak ada\n\n`;
            }

            summaryMessage += `🚫 *Dilewati (Token/Konfigurasi):* (${uniqueSkipped.length + uniqueTokenFailed.length})\n`;
            if (uniqueSkipped.length > 0) {
                summaryMessage += uniqueSkipped.map(name => `- ${name} (Sebab: Konfigurasi username tidak ada)`).join('\n') + '\n';
            }
            if (uniqueTokenFailed.length > 0) {
                summaryMessage += uniqueTokenFailed.map(name => `- ${name} (Sebab: Gagal memperbarui token)`).join('\n') + '\n';
            }
            if (uniqueSkipped.length === 0 && uniqueTokenFailed.length === 0) {
                summaryMessage += `- Tidak ada\n`;
            }
        }

        try {
            await whatsappClient.sendMessage(adminChatId, summaryMessage);
            console.log(`📱 Ringkasan siklus dikirim ke WA admin: ${config.wa_admin}`);
        } catch (waErr) {
            console.error(`❌ Gagal mengirim ringkasan WA ke admin ${config.wa_admin}:`, waErr.message);
        }
    }
}


async function main() {
    console.clear();
    console.log('====================================================');
    console.log('          SELAMAT DATANG DI BOT DISCORD VOTER         ');
    console.log('====================================================');
    console.log('\nPERINGATAN PENTING:');
    console.log('Untuk notifikasi WhatsApp, sangat disarankan menggunakan nomor BARU');
    console.log('atau nomor sekunder (nomor bot), BUKAN nomor pribadi Anda.');
    console.log('Ini untuk menghindari risiko pemblokiran pada nomor utama Anda.\n');

    const config = await readConfig();
    let whatsappClient = null;
    let withWhatsApp = false;

    if (config.wa_admin) {
        withWhatsApp = true;
        console.log(`\n✅ Fitur notifikasi WhatsApp aktif.Notifikasi akan dikirim ke ${config.wa_admin}.`);
    } else {
        console.log(`\n❌ Fitur notifikasi WhatsApp tidak aktif.Tambahkan "wa_admin" di config.json untuk mengaktifkannya.`);
    }

    const intervalHours = 5;
    const intervalInMs = intervalHours * 60 * 60 * 1000;
    console.log(`Siklus pengecekan akan berjalan setiap ${intervalHours} jam.`);

    while (true) {
        console.log(`\n\n-- - MEMULAI SIKLUS PENGECEKAN BARU-- - (${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })})--- `);

        try {
            if (withWhatsApp) {
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
                whatsappClient = null;
            }
        }

        console.log(`\n-- - SIKLUS SELESAI.Bot akan tidur selama ${intervalHours} jam. -- - `);
        await delay(intervalInMs);
    }
}

// Jalankan bot
main().catch(err => {
    console.error("FATAL ERROR, bot berhenti:", err);
    process.exit(1);
});