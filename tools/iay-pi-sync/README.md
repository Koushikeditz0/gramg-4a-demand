# IAY Pi Sync

Raspberry Pi-তে চলে। প্রতি ঘণ্টায় VB-G RAM G-এর public report-গুলো (R4.2, R4.4, R6.12) login ছাড়াই পড়ে, তারপর প্রতিটা GP-র IAY data **IAY Tracker**-এ পাঠায়। এর জন্য PC বা Chrome খোলা রাখতে হয় না। Data পড়ার যুক্তি IAY Phase Report Tampermonkey script-এরই (`vbr-core.js` file-টা script থেকে হুবহু নেওয়া)।

## ১. Pi-তে file আনা

```bash
cd ~
git clone https://github.com/Koushikeditz0/gramg-4a-demand.git
cd gramg-4a-demand/tools/iay-pi-sync
cp .env.example .env
nano .env        # SYNC_KEY= এর পরে Tracker-এর sync key paste করো
```

Sync key পাবে IAY Tracker → **📡 Tampermonkey live sync** থেকে। Tampermonkey script যে key ব্যবহার করছে, সেটাই এখানে দিতে পারো। **নতুন key বানালে পুরোনো key বন্ধ হয়ে যায়**, তখন দুই জায়গাতেই নতুন key বসাতে হবে।

## ২. প্রথমে test (কিছুই পাঠায় না)

```bash
docker compose build
docker compose run --rm iay-pi-sync node iay-sync.js --once --dry-run
```

Log-এ প্রতিটা GP-র জন্য `(dry run) PETLA: 1873 works, 3177 MR`-এর মতো লাইন এলে portal ঠিকমতো পড়া যাচ্ছে।

## ৩. একবার আসল sync

```bash
docker compose run --rm iay-pi-sync node iay-sync.js --once
```

এরপর Tracker-এ 🔄 Refresh চাপো। GP-র "Report" সময় এখনকার সময় দেখালে sync হয়েছে।

## ৪. সবসময় চালু রাখা

```bash
docker compose up -d
docker logs -f iay-pi-sync      # log দেখা (Ctrl+C চাপলে শুধু log দেখা বন্ধ হয়, sync চলতে থাকে)
```

`restart: unless-stopped` থাকায় Pi reboot হলেও নিজে থেকে আবার চালু হবে। শেষ run-এর ফল `data/status.json`-এ লেখা থাকে।

## Settings (`.env`)

| নাম | কাজ |
|---|---|
| `SYNC_KEY` | Tracker-এর sync key (দরকারি) |
| `INTERVAL_MIN` | কত মিনিট পরপর চলবে (কমপক্ষে 15; default 60) |
| `ACTIVE_HOURS` | ভারতীয় সময়ে কোন ঘণ্টাগুলোতে চলবে, যেমন `6-23` (রাতে বন্ধ থাকে) |
| `GPS` | খালি রাখলে পুরো block; নির্দিষ্ট GP চাইলে `PETLA,OKRABARI` |
| `R42_URL`, `R44_URL`, `R612_URL` | Report-এর link; খালি রাখলে script-এর DINHATA-I link ব্যবহার হয় |
| `EMP_URLS` | ঐচ্ছিক: GP-wise "Employment Provided" report-এর link (beneficiary-র নামের জন্য), যেমন `{"PETLA":"https://…"}`। না দিলে Tracker-এ আগে থেকে থাকা নাম রেখে দেওয়া হয় |

## সকালের summary (ntfy)

`.env`-এ `NTFY_URL` দিলে প্রতিদিন `DIGEST_TIME`-এ (default সকাল ৯টা) তোমার phone-এর ntfy app-এ একটা summary আসবে। তাতে থাকবে আগের pending, আজ আর কাল কতগুলো fill, WL বাকি, পরের MR কতগুলো লাগবে, কোন GP-তে সবচেয়ে বেশি pending, আর last update-এর সময়। Message-এ চাপলে public report খুলবে।

1. ntfy app-এ (Android) তোমার server যোগ করো, তারপর `iay-report` topic subscribe করো।
2. `.env`-এ `NTFY_URL=http://<Pi-র IP>:2586`, `PUBLIC_URL=<public link>` দাও।
3. এখনই একবার পাঠিয়ে test করো:
   ```bash
   docker compose run --rm iay-pi-sync node iay-sync.js --digest-now
   ```
4. `docker compose up -d` চালাও।

## Update

```bash
cd ~/gramg-4a-demand && git pull
cd tools/iay-pi-sync && docker compose up -d --build
```

## সমস্যা হলে

- **`Sync key is not valid`**: Tracker-এ নতুন key বানানো হয়েছে, অথবা key বন্ধ করা হয়েছে। নতুন key `.env`-এ বসিয়ে `docker compose up -d` চালাও।
- **`Page failed to load` / `HTTP 403`**: portal সাময়িকভাবে বন্ধ, অথবা Pi-কে আটকাচ্ছে। পরের run-এ আবার চেষ্টা হবে। বারবার এলে `INTERVAL_MIN` বাড়াও।
- **`R6.12 not read`**: mandays আর Job Card আগের মতোই থেকে যাবে, MR-এর status তবুও update হবে।
- Portal-এ খুব বেশি চাপ যাতে না পড়ে, তাই 15 মিনিটের কম interval দেওয়া যায় না।
