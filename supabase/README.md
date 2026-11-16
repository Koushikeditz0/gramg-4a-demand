# Supabase SQL files

এই folder-এর প্রতিটা `YYYY-MM-DD_<নাম>_vNNN.sql` হাতে চালাতে হয়:
Supabase dashboard → project **gramg-4a-demand** → SQL Editor → পুরো file paste → **Run**।
সবসময় পুরোনো নম্বর আগে।

## কোনটা চালানো হয়েছে? (v224 থেকে)

Database নিজেই মনে রাখে: `public.schema_versions` table। Admin panel-এর উপরে **DB v224**-এর মতো লেখা দেখায়।
App যদি database-এর চেয়ে নতুন SQL চায়, Admin-এ লাল সতর্কবার্তা আসে: কোন version দরকার।

### নতুন SQL লেখার নিয়ম
1. File-এর নাম পরের নম্বর দিয়ে: `2026-11-20_<কাজ>_v225.sql`।
2. File-এর **শেষ লাইন**:
   ```sql
   select private.schema_mark(225, 'এক লাইনে কী বদলাল');
   ```
3. App-এর যে অংশ এই SQL ছাড়া চলবে না, তাহলে `v2/js/admin-dbver.js`-এ `NEEDED_DB = 225` করো।
4. বড় বদল হলে আগে **gramsetu-test** project-এ চালিয়ে দেখো (`tools/backup/README.md` → Restore drill দিয়ে test project-এ আসল data-র কপি আনা যায়)।

v1–v174 এর file এই repo-তে নেই। পুরো database-এর গঠন (সব table, function, RLS) রোজকার encrypted backup-এর `app.dump`-এ থাকে, আর Restore drill প্রমাণ করে যে সেটা দিয়ে database শূন্য থেকে বানানো যায়।
