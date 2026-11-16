# K-Desk update feed

K-Desk Suite (v1.20.0 and newer) reads `https://gramsetu.koushiktech.co.in/kdesk/latest.json`
every 6 hours. If `version` is newer than the installed one, the toolbar icon shows **NEW** and the
Dashboard shows a banner with the notes and a **Download zip** button.

## নতুন version প্রকাশ করার নিয়ম
1. নতুন zip (যেমন `K-Desk_Suite_v1.21.0.zip`) এই `kdesk/` folder-এ রাখুন, পুরনো zip মুছে দিন (repo ছোট থাকে)।
2. `latest.json`-এ বদলান:
   - `version`: `"1.21.0"` (manifest.json-এর সাথে হুবহু এক)
   - `date`: প্রকাশের তারিখ
   - `url`: zip-এর নাম (এই folder-এ), বা পুরো https link (যেমন Google Drive)
   - `notes`: কী নতুন, ৪টা পর্যন্ত লাইন দেখায়
   - `min_version`: খালি রাখুন। শুধু portal বদলে পুরনো version ভুল কাজ করলে দিন (যেমন `"1.21.0"`):
     তার নিচের সবাই লাল "জরুরি update" দেখবে, "পরে" বোতাম থাকবে না।
3. Commit → main-এ merge। GitHub Pages ১-২ মিনিটে আপডেট হয়; K-Desk ৬ ঘণ্টার মধ্যে (বা Settings → 🔄 এখনই দেখুন) ধরবে।

Note: এই repo public, তাই zip যে কেউ নামাতে পারে। K-Desk চালাতে activation key লাগে, তাই সেটা নিরাপদ।
