G RAM-G 4A/Demand List Builder — PWA v1.3.1 API Fix

1) Apps Script Code.gs-এর backup নিন।
2) G_RAMG_4A_Demand_List_Builder_API_Code_v1.3.1.gs-এর সম্পূর্ণ code বর্তমান Code.gs-এ বসিয়ে Save করুন।
3) Deploy > Manage deployments > Edit > New version > Deploy করুন। Web App access Anyone থাকা চাই।
4) GitHub repository-তে index.html, manifest.json, service-worker.js, icon-192.png, icon-512.png আপডেট করুন। ZIP upload করবেন না।
5) GitHub Pages খুলে Ctrl+Shift+R দিয়ে refresh করুন।

Note: API এখন JSONP GET request-এ সরাসরি action চালায়; আগের doPost/cache-poll flow সরানো হয়েছে। বড় saveSelection URL 7000 character-এর বেশি হলে frontend request length error দেখাতে পারে; সে ক্ষেত্রে আলাদা secure transport design লাগবে।
