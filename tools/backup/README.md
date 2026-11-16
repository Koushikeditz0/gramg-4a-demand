# Gram Setu — Supabase nightly backup

প্রতি রাতে **02:30 IST**-এ GitHub Actions নিজে থেকে Supabase database-এর পুরো backup নেয়, **encrypt** করে, আর Cloudflare R2-এর private bucket **`gramg-backups`**-এ রাখে।

```
GitHub Actions (রাত 02:30)
  └─ pg_dump (read-only user gramg_backup)
       ├─ app.dump   = public + private schema (সব table, data, function, RLS, grant)
       └─ auth.dump  = auth.users + auth.identities (সবার login)
  └─ age দিয়ে encrypt (শুধু public key runner-এ থাকে)
  └─ R2: gramg-backups/daily/gramsetu_YYYY-MM-DD_HHMM.tar.age   (শেষ 30টা থাকে)
         gramg-backups/monthly/…  (প্রতি মাসের 1 তারিখের কপি, শেষ 12টা থাকে)
```

## নিরাপত্তা কেন ঠিক আছে

- Repo public, তাই script কখনো data, URL বা key log-এ print করে না। Log-এ শুধু file size আর table সংখ্যা দেখায়।
- File **age** দিয়ে encrypt হয়। Runner-এ শুধু **public key** থাকে। খোলার **private key শুধু Koushik-এর কাছে** থাকে (GitHub বা Cloudflare-এ কোথাও নেই)। তাই GitHub secret বা R2 token চুরি গেলেও backup কেউ খুলতে পারবে না।
- DB user `gramg_backup` **read-only**: সব table পড়তে পারে, কিন্তু কিছু বদলাতে বা মুছতে পারে না।
- R2 bucket private (public URL বন্ধ)। R2 token শুধু এই bucket-এর জন্য।

## একবারের setup (Koushik)

### 1. Encryption key বানান (Windows PC-তে)
1. https://github.com/FiloSottile/age/releases থেকে `age-v1.2.1-windows-amd64.zip` নামান, unzip করুন (যেমন `C:\age\`)।
2. PowerShell-এ:
   ```powershell
   cd C:\age
   .\age-keygen.exe -o gramsetu-backup-key.txt
   ```
   Screen-এ `Public key: age1....` দেখাবে। এই **public key** লাইনটা কপি করুন।
3. `gramsetu-backup-key.txt` হলো **private key**। এটা **দুই জায়গায়** রাখুন (যেমন pen drive + নিজের Google Drive-এর private folder)। এটা হারালে কোনো backup আর খোলা যাবে না। কাউকে দেবেন না, chat-এ পাঠাবেন না।

### 2. Read-only DB user বানান
1. `supabase/2026-11-16_backup_reader_v216.sql` খুলুন, `CHANGE_ME_STRONG_PASSWORD` (দুই জায়গায়) বদলে একটা লম্বা password দিন (শুধু অক্ষর + সংখ্যা, 24+ অক্ষর)।
2. Supabase → SQL Editor-এ paste করে Run। শেষে `gramg_backup | true | true` দেখালে ঠিক আছে।

### 3. Connection URL বানান
Supabase Dashboard → **Connect** → **Session pooler** (port **5432**) URI কপি করুন। দেখতে এরকম:
```
postgresql://postgres.wbzybizfpdalpukfzefk:[YOUR-PASSWORD]@aws-X-ap-northeast-1.pooler.supabase.com:5432/postgres
```
এতে `postgres.` বদলে `gramg_backup.` লিখুন আর `[YOUR-PASSWORD]`-এর জায়গায় step 2-এর password:
```
postgresql://gramg_backup.wbzybizfpdalpukfzefk:আপনার_password@aws-X-ap-northeast-1.pooler.supabase.com:5432/postgres
```
(Direct connection `db.wbzy….supabase.co` কাজ করবে না, কারণ GitHub runner-এ IPv6 নেই। Session pooler-ই লাগবে।)

### 4. R2 API token
Cloudflare → R2 → **Manage R2 API Tokens** → **Create API token**:
- Permission: **Object Read & Write**
- Specify bucket: **gramg-backups** (শুধু এটা)
- Create করলে **Access Key ID** আর **Secret Access Key** দেখাবে, কপি করুন। R2 পাতার ডান দিকে **Account ID**-ও কপি করুন।

### 5. GitHub-এ বসান
Repo → Settings → **Secrets and variables → Actions**

**Secrets** tab:
| Name | Value |
|---|---|
| `SUPABASE_BACKUP_DB_URL` | step 3-এর URL |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_BACKUP_ACCESS_KEY_ID` | R2 Access Key ID |
| `R2_BACKUP_SECRET_ACCESS_KEY` | R2 Secret Access Key |

**Variables** tab:
| Name | Value |
|---|---|
| `BACKUP_AGE_RECIPIENT` | step 1-এর public key (`age1…`) |

(`R2_BACKUP_BUCKET` না দিলে `gramg-backups` ধরে নেয়।)

### 6. প্রথম test
Repo → **Actions** → **Supabase nightly backup** → **Run workflow**। সবুজ ✓ হলে R2 → gramg-backups → `daily/`-এ একটা `.tar.age` file দেখা যাবে। Fail করলে GitHub নিজে email পাঠায়।

## Backup থেকে data ফেরত আনা (restore)

### File খোলা (Windows)
1. R2 → gramg-backups → daily/ থেকে দরকারি `.tar.age` download করুন।
2. PowerShell:
   ```powershell
   cd C:\age
   .\age.exe -d -i gramsetu-backup-key.txt -o backup.tar gramsetu_2026-11-16_0230.tar.age
   tar -xf backup.tar
   ```
   ভিতরে থাকবে `app.dump`, `auth.dump`, `row_counts.tsv` (কোন table-এ কত row), `manifest.txt`।

### পুরো database ফেরত (নতুন বা খালি Supabase project-এ)
PostgreSQL 17 client লাগবে (Windows-এ PostgreSQL installer থেকে শুধু "Command Line Tools", বা Pi-তে `postgresql-client-17`)। নতুন project-এর **Session pooler** URL `postgres` user দিয়ে:
```bash
# 1) App tables + functions + RLS (একটা "schema public already exists" error আসবে, ওটা স্বাভাবিক)
pg_restore --no-owner -d "NEW_DB_URL" app.dump
# 2) Login গুলো
pg_restore --data-only -d "NEW_DB_URL" auth.dump
```
তারপর app-এর `v2/js/config.js`-এ নতুন project-এর URL/key, edge function `admin-users` আবার deploy, আর Cloudflare Worker-এর Supabase URL বদলাতে হবে।

### শুধু একটা table দেখা / একটা row ফেরত আনা
```bash
pg_restore --list app.dump | grep "TABLE DATA"          # কোন কোন table আছে
pg_restore -a -t workers -f workers.sql app.dump         # শুধু workers table-এর data, SQL file হিসেবে
```
পুরো DB overwrite না করে এভাবে একটা table আলাদা দেখে দরকারি row ফেরত বসানো নিরাপদ।

## কিছু কথা
- Backup-এ **শুধু database** থাকে। R2-এর ছবি (gramg-photos) আলাদা; ওগুলো এমনিতেই কিছুদিন পর auto-delete হয়।
- আকার: এখন ~45 MB DB → encrypt করা file কয়েক MB। 30 daily + 12 monthly মিলিয়ে R2-এর free 10 GB-র খুব ছোট অংশ।
- Public repo-তে 60 দিন কোনো commit না হলে GitHub scheduled workflow বন্ধ করে দেয়। তখন Actions পাতায় "Enable workflow" চাপলেই আবার চালু হয়।
- Script local-এ test: `SKIP_UPLOAD=1 OUT_DIR=. DB_URL=… AGE_RECIPIENT=age1… bash tools/backup/backup.sh`
