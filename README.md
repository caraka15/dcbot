# Bot Voter Poll Discord dengan Notifikasi WhatsApp

Sebuah bot Node.js otomatis untuk berpartisipasi dalam polling di channel Discord tertentu. Bot ini mendukung banyak akun, dapat melakukan login ulang secara otomatis jika token kadaluwarsa, dan memberikan notifikasi melalui WhatsApp setelah berhasil melakukan vote.

## ✨ Fitur

- **Multi-Akun**: Mendukung banyak akun Discord dalam satu file konfigurasi.
- **Voting Acak**: Memilih salah satu jawaban dari poll secara acak agar tidak monoton.
- **Login Ulang Otomatis**: Jika token otorisasi sudah tidak valid, bot akan mencoba login ulang menggunakan kredensial dan 2FA untuk mendapatkan token baru.
- **Notifikasi WhatsApp**: Mengirimkan pemberitahuan ke nomor WhatsApp yang ditentukan setelah berhasil melakukan vote.
- **Mode Fleksibel**: Dapat dijalankan dengan atau tanpa notifikasi WhatsApp untuk menghemat sumber daya.
- **Siklus Periodik**: Dijalankan dalam siklus yang dapat diatur (misalnya, setiap 5 jam).
- **Hemat Sumber Daya**: Arsitektur "On-Demand" untuk WhatsApp, hanya menyalakan client saat dibutuhkan.

---

## 📋 Prasyarat

Sebelum memulai, pastikan sistem Anda telah terinstal:

- [Node.js](https://nodejs.org/) (disarankan versi 18 atau lebih tinggi)
- [Git](https://git-scm.com/)
- [FFMPEG](https://ffmpeg.org/) (**Wajib** agar fungsionalitas WhatsApp berjalan stabil)

---

## 🚀 Instalasi & Konfigurasi

Ikuti langkah-langkah berikut untuk menyiapkan dan menjalankan bot.

1.  **Clone Repository**
    Buka terminal atau command prompt, lalu clone repository ini ke komputer Anda.

    ```bash
    git clone https://github.com/caraka15/dcbot.git
    ```

2.  **Masuk ke Direktori Proyek**

    ```bash
    cd dcbot
    ```

3.  **Install Dependencies**
    Jalankan perintah berikut untuk menginstal semua library yang dibutuhkan (`puppeteer`, `whatsapp-web.js`, dll).

    ```bash
    npm install
    ```

4.  **Buat File Konfigurasi**
    Salin file contoh konfigurasi untuk membuat file konfigurasi Anda sendiri.

    - Untuk Linux/macOS:
      ```bash
      cp config_example.json config.json
      ```

5.  **Edit File Konfigurasi**
    Buka file `config.json` bisa menggunakan `nano config.json` dengan teks editor dan isi semua data yang diperlukan sesuai dengan akun Anda. Lihat penjelasan detail mengenai struktur `config.json` di bawah. Pastikan semua field terisi dengan benar.

---

## ▶️ Menjalankan Bot

Setelah konfigurasi selesai, Anda bisa menjalankan bot.

**Penting:** Sebelum menjalankan di server atau di latar belakang, pastikan Anda mengatur `"display": "off"` di dalam file `config.json` Anda untuk mengaktifkan mode _headless_. Untuk debugging, Anda bisa mengaturnya ke `"on"`.

#### 1. Mode Normal (Foreground)

Jalankan perintah ini untuk memulai bot. Mode ini cocok untuk percobaan awal dan melihat log secara langsung di terminal.

```bash
node bot.js
```

pilih untuk menggunakan notifikasi wa atau tidak
Saat pertama kali dijalankan dengan mode notifikasi, Anda akan diminta memindai QR code WhatsApp

#### 2. Mode Latar Belakang (Background) dengan `screen`

Untuk menjalankan bot secara terus-menerus di server, disarankan menggunakan `screen`.

1.  Mulai sesi `screen` baru dengan nama yang mudah diingat (misalnya, `discord-bot`).

    ```bash
    screen -Rd discord-bot
    ```

2.  Setelah masuk ke dalam sesi `screen`, jalankan bot seperti biasa:

    ```bash
    node bot.js
    ```

3.  Untuk keluar dari sesi `screen` tanpa menghentikan bot (detach), tekan `Ctrl+A` lalu `D`.

4.  Untuk masuk kembali ke sesi tersebut nanti, gunakan perintah:
    ```bash
    screen -r discord-bot
    ```

---

## ⚙️ Struktur `config.json`

File ini adalah jantung dari bot. Berikut penjelasan untuk setiap field:

```json
{
  "display": "off",
  "targetUrl": "[https://discord.com/login](https://discord.com/login)",
  "appUrl": "[https://discord.com/channels/@me](https://discord.com/channels/@me)",
  "pollChannelUrl": "[https://discord.com/channels/GUILD_ID/CHANNEL_ID](https://discord.com/channels/GUILD_ID/CHANNEL_ID)",
  "whatsappSessionPath": "./whatsapp_session",
  "display": "on"
  "accounts": [
    {
      "accountName": "Nama Akun (untuk log)",
      "email": "email@discord.com",
      "password": "password_discord",
      "twoFactorSecret": "SECRET_KEY_DARI_APLIKASI_AUTHENTICATOR",
      "userDataDir": "./cache/session_data_namaakun",
      "whatsappNumber": "628xxxxxxxxxx"
    }
  ]
}
```

- **`display`**: Mengontrol apakah browser automasi (Puppeteer) akan ditampilkan.
  - `"off"`: Mode _headless_, browser tidak terlihat. Gunakan ini untuk produksi atau saat berjalan di server.
  - `"on"`: Mode normal, browser akan muncul di layar. Gunakan ini untuk debugging jika terjadi masalah.
- **`pollChannelUrl`**: URL lengkap menuju channel Discord tempat poll berada. Bot akan otomatis mengambil ID channel dari sini.
- **`whatsappSessionPath`**: Lokasi untuk menyimpan file sesi WhatsApp. Biarkan default jika tidak ada kebutuhan khusus.
- **`accounts`**: Sebuah array yang berisi objek untuk setiap akun Discord yang ingin Anda jalankan.
  - **`accountName`**: Nama bebas untuk identifikasi di log.
  - **`email`**, **`password`**: Kredensial login Discord.
  - **`twoFactorSecret`**: Kunci rahasia (bukan kode 6 digit) dari aplikasi authenticator Anda (Google Authenticator, Authy, dll) untuk generate kode 2FA.
  - **`userDataDir`**: Lokasi unik untuk menyimpan cache sesi login Discord per akun.
  - **`whatsappNumber`**: Nomor WA tujuan notifikasi untuk akun ini (format internasional tanpa `+` atau `0`).
  - **`authToken`**: Boleh dikosongkan (`null`). Bot akan mengisinya secara otomatis setelah berhasil login.

---

## ⚠️ Peringatan Keamanan

- File `config.json` berisi semua informasi sensitif Anda. **JANGAN PERNAH** membagikan file ini atau mengunggahnya ke repository publik seperti GitHub.
- Pastikan file `.gitignore` sudah ada untuk mencegah `config.json` dan folder sesi terunggah secara tidak sengaja.
