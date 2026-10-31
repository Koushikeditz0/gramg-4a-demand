/* English / বাংলা switch for the supervisor app.
   The app is written in Bengali; in English mode every Bengali phrase on screen is
   swapped for its English text (longest phrase first), including messages that appear later.
   The User Guide stays in Bengali. Switching back to বাংলা reloads the page. */
(function () {
  var KEY = 'GramG2_lang';
  var lang = 'bn';
  try { lang = localStorage.getItem(KEY) === 'en' ? 'en' : 'bn'; } catch (e) {}

  var D = {
    // header, login
    'শ্রমিক নির্বাচন, তালিকা প্রস্তুতি ও ডিমান্ড ব্যবস্থাপনা': 'Worker selection, list making and demand management',
    'Username এবং PIN দিন।': 'Enter the username and PIN.',
    'Login হচ্ছে...': 'Logging in...',
    'আগের Login চালু হচ্ছে...': 'Restoring your login...',
    'Username সঠিক নয়।': 'The username is not valid.',
    'PIN কমপক্ষে ৬ সংখ্যার। পুরনো ছোট PIN চলবে না — Administrator-এর কাছ থেকে নতুন PIN নিন।': 'The PIN has at least 6 digits. Old short PINs do not work; get a new PIN from the administrator.',
    'Username/PIN ভুল অথবা user inactive।': 'Wrong username/PIN, or the user is inactive.',
    'আপনার account বন্ধ করা আছে। Administrator-এর সঙ্গে যোগাযোগ করুন।': 'Your account is disabled. Contact the administrator.',
    'আপনার account বন্ধ করা হয়েছে। Administrator-এর সঙ্গে যোগাযোগ করুন।': 'Your account has been disabled. Contact the administrator.',
    'Admin panel খুলছে...': 'Opening the admin panel...',
    'এটা K-Desk login, শুধু অফিসের K-Desk extension-এ চলে।': 'This is a K-Desk login; it works only in the office K-Desk extension.',
    'এই account-এর অনুমতি নেই।': 'This account has no permission.',
    'Server-এর সঙ্গে যোগাযোগ হয়নি। Internet connection দেখে আবার চেষ্টা করুন।': 'Could not reach the server. Check the internet connection and try again.',
    'নিরাপত্তার জন্য আপনার সবচেয়ে পুরনো device থেকে Logout করা হয়েছে (একটি account সর্বোচ্চ ২টি device-এ চালু থাকতে পারে)।': 'For safety, your oldest device was logged out (one account can be open on at most 2 devices).',
    'এই account-এ অন্য একটি device-এ নতুন Login হয়েছে। একটি account সর্বোচ্চ ২টি device-এ চালু থাকতে পারে, তাই এই device-এর session বন্ধ করা হয়েছে। আবার Login করুন।': 'This account was logged in on another device. One account can be open on at most 2 devices, so this device was logged out. Please log in again.',
    'Session শেষ হয়ে গেছে অথবা অন্য device-এ Login হওয়ায় বাতিল হয়েছে। আবার Login করুন।': 'The session ended or was closed by a login on another device. Please log in again.',
    'Session শেষ হয়ে গেছে। আবার Login করুন — আপনার list এই device-এ save আছে, Login করলে ফিরে আসবে।': 'The session ended. Please log in again; your list is saved on this device and comes back after login.',
    'Session শেষ হয়ে গেছে। আবার Login করুন।': 'The session ended. Please log in again.',
    'এই device-এর না-পাঠানো selection রাখা আছে, Login করলে ফিরে আসবে।': 'Unsent selections on this device are kept and come back after login.',
    '📅 শেষ data:': '📅 Last data:',
    'data: নেই': 'data: none',
    'শেষ data': 'Last data',
    '(পুরনো)': '(old)',
    // install
    '✅ App home screen-এ যোগ হয়েছে। এরপর icon থেকে খুলুন।': '✅ The app was added to the home screen. Open it from the icon from now on.',
    '📲 Phone-এ app হিসেবে রাখুন': '📲 Keep it on the phone as an app',
    'Phone-এ app হিসেবে রাখুন': 'Keep it on the phone as an app',
    '১. নিচে বা উপরে': '1. Tap the',
    'বাটন (□↑) চাপুন।': 'button (□↑) at the bottom or top.',
    '৩. ডানদিকে উপরে': '3. Tap',
    'Safari-তে খুললে তবেই এটা দেখা যায়।': 'This shows only when the page is opened in Safari.',
    'Chrome-এ উপরে ডানদিকে': 'In Chrome tap',
    'চাপুন →': 'at the top right →',
    'ঠিক আছে': 'OK',
    'বন্ধ করুন': 'Close',
    // list area
    '➕ নতুন list (নতুন কাজ)': '➕ New list (new work)',
    '➕ নতুন list': '➕ New list',
    '← আমার list': '← My lists',
    'আমার list খুলছে...': 'Opening my lists...',
    'টা, সর্বোচ্চ ৫টা) — খুলতে ছুঁয়ে দিন': ', at most 5) — tap one to open',
    ') — খুলতে ছুঁয়ে দিন': ') — tap one to open',
    '📋 My list — খুলতে ছুঁয়ে দিন': '📋 My list — tap one to open',
    '✕ নতুন list বন্ধ করুন': '✕ Close new list',
    '✏️ নাম/Code': '✏️ Name/Code',
    'কোনো Draft নেই': 'No drafts',
    'এখনো কোনো list জমা হয়নি': 'No list submitted yet',
    ' জমা · Supervisor': ' submitted · Supervisor',
    'আমার list (': 'My lists (',
    'কোন কাজের list': 'Which work\'s list',
    '— আগের list দেখতে এখানে বাছুন —': '— pick an earlier list to see it —',
    '⚠ ৫টা list হয়ে গেছে। নতুন list খুলতে আগে পুরনো একটা list বেছে "🗑 List মুছুন" চাপুন, অথবা Admin-কে বলুন।': '⚠ You already have 5 lists. To open a new one, first open an old list and tap "🗑 Delete list", or ask the admin.',
    '📝 নতুন কাজের জন্য "➕ নতুন list" চাপুন আর কাজের নাম (Work Name) দিন। একই গ্রামে একাধিক কাজ থাকলে প্রতি কাজে আলাদা list।': '📝 For new work tap "➕ New list" and give the Work Name. If one village has several works, make one list per work.',
    'জমা দেওয়া list উপরের তালিকা থেকে বেছে দেখা যাবে।': 'Submitted lists can be opened from the list above.',
    '📝 খসড়া — বাছাই শেষ হলে Submit চাপুন': '📝 Draft — tap Submit when you finish picking',
    '✅ জমা দেওয়া হয়েছে': '✅ Submitted',
    '🔒 Admin list lock করেছেন — বদলানো যাবে না': '🔒 The admin locked this list — it cannot be changed',
    'খসড়া': 'Draft',
    'জমা দিয়েছে': 'Submitted',
    'Lock করা': 'Locked',
    '(নাম নেই)': '(no name)',
    '🗑 List মুছুন': '🗑 Delete list',
    '🗑 মুছুন': '🗑 Delete',
    '✏️ নাম/Supervisor': '✏️ Name/Supervisor',
    '📋 ফলাফল': '📋 Results',
    '📋 K-Desk ফলাফল': '📋 K-Desk results',
    'K-Desk-এ Demand / Allocation-এর ফলাফল': 'Demand / Allocation results from K-Desk',
    'ফলাফল আনছি...': 'Loading results...',
    'এই list এখনো K-Desk-এ চালানো হয়নি।': 'This list has not been run in K-Desk yet.',
    '✓ সফল': '✓ Done', '⊘ বাদ': '⊘ Skipped', 'সফল': 'Done',
    // steps, tabs, bar
    '🔎 খুঁজুন': '🔎 Search',
    '✅ বাছাই (': '✅ Picked (',
    'জন বাছাই': 'picked',
    '⚠ ③ Supervisor-এ নাম দিন': '⚠ Add names in ③ Supervisor',
    'worker খুঁজে ছুঁয়ে বাছুন': 'search and tap workers to pick',
    'আরও': 'More',
    '▥ ২ column': '▥ 2 columns',
    '▤ ১ column': '▤ 1 column',
    '১ column চালু হয়েছে। পাশাপাশি দেখতে "▥ ২ column" চাপুন।': '1 column is on. Tap "▥ 2 columns" to see them side by side.',
    '২ column চালু হয়েছে। এক column-এ দেখতে "▤ ১ column" চাপুন।': '2 columns are on. Tap "▤ 1 column" for one column.',
    'এক column: খুঁজুন / বাছাই tab, বড় row, নিচে Submit': 'One column: Search / Picked tabs, big rows, Submit at the bottom',
    'Search আর বাছাই পাশাপাশি': 'Search and Picked side by side',
    '🧹 Clear': '🧹 Clear',
    // search
    'Village changed. Selected list রাখা হয়েছে।': 'Village changed. The selected list is kept.',
    'Job Card search করুন।': 'Search a Job Card.',
    'আগে Job Card search করুন।': 'Search a Job Card first.',
    'নাম দিয়ে খুঁজতে কমপক্ষে ২টি অক্ষর লিখুন।': 'Type at least 2 letters to search by name.',
    'নাম দিয়ে search হচ্ছে...': 'Searching by name...',
    'জন worker পাওয়া গেছে': 'workers found',
    '(প্রথম ১০০ জন — নাম আরও নির্দিষ্ট করুন)': '(first 100 — make the name more exact)',
    'এই নামে কোনো worker পাওয়া যায়নি।': 'No worker found with this name.',
    'আগে Village select করুন।': 'Select a village first.',
    'টি Job Card অন্য GP-র, সেগুলো বাদ দেওয়া হয়েছে।': ' Job Card(s) belong to another GP and were left out.',
    'Valid Job Card পাওয়া যায়নি।': 'No valid Job Card found.',
    'একবারে সর্বোচ্চ ৫০০টি Job Card search করা যায়। Range ছোট করুন।': 'At most 500 Job Cards can be searched at once. Make the range smaller.',
    'Beneficiary search হচ্ছে...': 'Searching beneficiaries...',
    'টি Job Card পাওয়া গেছে।': ' Job Card(s) found.',
    'কোনো Job Card পাওয়া যায়নি।': 'No Job Card found.',
    'এই worker অন্য list-এ আছেন': 'This worker is in another list',
    'eKYC এবং ABPS দুটোই YES না হলে select করা যাবে না': 'Cannot be selected unless both eKYC and ABPS are YES',
    'অন্য supervisor-এর list-এ আছে': 'In another supervisor\'s list',
    '" list-এ আছে': '" list',
    'আপনার "': 'In your "',
    'এখনো কোনো worker select করা হয়নি।': 'No worker selected yet.',
    'Current search-এর সব worker selected হয়েছে।': 'All workers of this search are selected.',
    'জন eKYC + ABPS worker selected হয়েছে।': 'eKYC + ABPS worker(s) selected.',
    'সব selected worker remove করবেন?': 'Remove all selected workers?',
    'Selected list clear হয়েছে।': 'The selected list was cleared.',
    'Local list clear হয়েছে, server list clear হয়নি:': 'Cleared on this device, but not on the server:',
    'সর্বশেষ জমা দেওয়া list দেখানো হচ্ছে।': 'Showing the last submitted list.',
    'Server-এ save হয়নি (এই device-এ save আছে, Internet ফিরলে আবার চেষ্টা হবে):': 'Not saved on the server (kept on this device; it will retry when the internet is back):',
    'Internet নেই — পরিবর্তন এই device-এ রাখা আছে, Internet ফিরলে save হবে।': 'No internet — changes are kept on this device and will be saved when the internet is back.',
    'জন worker ইতিমধ্যে অন্য list-এ আছেন।': 'worker(s) are already in another list.',
    'জনের eKYC/ABPS YES নয় অথবা data-তে নেই।': 'worker(s) are not eKYC/ABPS YES or are not in the data.',
    'তাঁদের এই list থেকে বাদ দেওয়া হয়েছে।': 'They were removed from this list.',
    'জন worker restore হয়েছে (এই device-এর unsaved কাজ সহ)।': 'worker(s) restored (with unsaved work from this device).',
    'জন saved worker restore হয়েছে।': 'saved worker(s) restored.',
    'Server পাওয়া যায়নি; এই device-এর': 'Server not reachable; showing this device\'s',
    'জন worker দেখাচ্ছে।': 'worker(s).',
    'সর্বশেষ saved list load হয়েছে (': 'Loaded the latest saved list (',
    'পরিবর্তন এখনো save হচ্ছে। "Saved ✓" দেখালে আবার চেষ্টা করুন।': 'Changes are still saving. Try again when it shows "Saved ✓".',
    // preview, pdf, excel
    'কোনো worker selected হয়নি।': 'No worker selected.',
    'Final list প্রস্তুত হচ্ছে...': 'Preparing the final list...',
    'PDF তৈরি হচ্ছে...': 'Making the PDF...',
    'PDF library load হয়নি। Internet connection check করুন।': 'The PDF library did not load. Check the internet connection.',
    'Excel তৈরি হচ্ছে...': 'Making the Excel file...',
    'Excel library load হয়নি। Internet connection check করুন।': 'The Excel library did not load. Check the internet connection.',
    'PDF বানানোর জন্য কোনো worker পাওয়া যায়নি।': 'No worker found for the PDF.',
    'জন worker-এর A4 PDF download হয়েছে।': 'worker(s): A4 PDF downloaded.',
    'PDF তৈরি করা যায়নি:': 'Could not make the PDF:',
    'জন worker-এর Final Excel download হয়েছে।': 'worker(s): final Excel downloaded.',
    // list actions
    'আগে একটা list খুলুন: উপরে "➕ নতুন list" চাপুন।': 'Open a list first: tap "➕ New list" above.',
    'Admin এই list lock করেছেন, এখন বদলানো যাবে না।': 'The admin locked this list; it cannot be changed now.',
    'List জমা দেওয়া আছে। বদলাতে চাইলে আগে "↩ Edit" চাপুন।': 'The list is submitted. To change it, tap "↩ Edit" first.',
    'List খুলছে...': 'Opening the list...',
    'একসঙ্গে সর্বোচ্চ ৫টা চলতি list রাখা যায়। পুরনো list শেষ হলে নতুন খুলুন।': 'At most 5 open lists at a time. Open a new one when an old list is finished.',
    'একসঙ্গে সর্বোচ্চ ৫টা চলতি list রাখা যায়।': 'At most 5 open lists at a time.',
    'Work Name লিখুন।': 'Enter the Work Name.',
    'নতুন list খুলছে...': 'Opening the new list...',
    '" list খোলা হয়েছে। এবার worker খুঁজে বাছুন।': '" list is open. Now search and pick workers.',
    '" list খোলা হয়েছে। এবার worker বাছুন, তারপর Supervisor-এর নাম দিন।': '" list is open. Pick workers, then give the supervisor names.',
    'List খোলা হয়েছে, কিন্তু Work Code save হয়নি (': 'The list is open, but the Work Code was not saved (',
    ')। "③ Supervisor" থেকে আবার দিন।': '). Enter it again in "③ Supervisor".',
    'Work Code-এর format মেলেনি। ঠিক করুন অথবা খালি রাখুন।': 'The Work Code format does not match. Fix it or leave it empty.',
    'Work Code-এর format মেলেনি (যেমন 3206003006/IF/93393042892327)।': 'The Work Code format does not match (e.g. 3206003006/IF/93393042892327).',
    '(পরে দিলেও চলবে)': '(can be added later)',
    'Work Name — কোন কাজের list?': 'Work Name — which work is this list for?',
    'যেমন: Pukur Khanan, Village 002': 'e.g. Pukur Khanan, Village 002',
    'একই গ্রামে একাধিক কাজ চললে প্রতি কাজের জন্য আলাদা list খুলুন (সর্বোচ্চ ৫টা)। একজন worker একসময়ে একটাই list-এ থাকতে পারেন।': 'If one village has several works, open one list per work (at most 5). A worker can be in only one list at a time.',
    'বাতিল': 'Cancel',
    'List খুলুন': 'Open list',
    '👷 Supervisor ও List-এর তথ্য': '👷 Supervisor and list details',
    'Supervisor-এর নাম': 'Supervisor names',
    '+ আরেকজন Supervisor': '+ Another supervisor',
    '-এর নাম': ' name',
    'বাদ দিন': 'Remove',
    'নাম ইংরেজিতে লিখুন (PDF-এ বাংলা অক্ষর ঠিক দেখায় না)। নিয়ম: প্রতি ২০ জন worker-এ ১ জন Supervisor, কমপক্ষে ১ জন (৪০ জনে ২, ৬০ জনে ৩)।': 'Write names in English (Bengali letters do not show well in the PDF). Rule: 1 supervisor per 20 workers, at least 1 (2 for 40, 3 for 60).',
    '— এখন': '— now',
    'জন worker,': 'workers,',
    'জন লাগবে': 'needed',
    'Save হচ্ছে...': 'Saving...',
    'Save হয়েছে। মনে রাখবেন:': 'Saved. Remember:',
    'জন Supervisor লাগবে, দেওয়া আছে': 'supervisor(s) needed, given',
    '✅ List-এর তথ্য save হয়েছে।': '✅ List details saved.',
    'Admin এই list lock করেছেন, তাই মোছা যাবে না। দরকার হলে Admin-কে বলুন।': 'The admin locked this list, so it cannot be deleted. Ask the admin if needed.',
    '" list মুছবেন?': '" — delete this list?',
    'এতে': 'It has',
    'জন worker আছে। মুছলে এরা আবার নতুন list-এ নেওয়া যাবে।': 'worker(s). After deleting, they can be picked for a new list again.',
    'List-টা জমা দেওয়া আছে, মুছলে Admin-এর কাছেও আর দেখাবে না।': 'The list is submitted; after deleting, the admin will not see it either.',
    'List মোছা হচ্ছে...': 'Deleting the list...',
    'List মোছা হয়েছে।': 'The list was deleted.',
    'খালি list জমা দেওয়া যায় না। আগে worker select করুন।': 'An empty list cannot be submitted. Select workers first.',
    'Submit করার আগে Work Name লিখুন।': 'Enter the Work Name before submitting.',
    'জন worker-এর জন্য': 'workers need',
    'জন Supervisor-এর নাম লাগবে (দেওয়া আছে': 'supervisor name(s) (given',
    'জন worker সহ list Admin-কে জমা দেবেন?': 'workers — submit the list to the admin?',
    'পরে বদলাতে হলে "↩ Edit" চাপতে হবে।': 'To change it later, tap "↩ Edit".',
    'List জমা দেওয়া হচ্ছে...': 'Submitting the list...',
    'জন worker সহ list জমা দেওয়া হয়েছে। নতুন কাজের জন্য "➕ নতুন list" চাপুন।': 'workers — the list was submitted. Tap "➕ New list" for new work.',
    'List খোলা হচ্ছে...': 'Opening the list...',
    'এখন list বদলাতে পারবেন। শেষ হলে আবার Submit করুন।': 'You can change the list now. Submit again when done.',
    'আপনার list পাওয়া যায়নি। Page reload করে আবার চেষ্টা করুন।': 'Your list was not found. Reload the page and try again.',
    'অন্য একটি device-এ এই list এইমাত্র পরিবর্তন হয়েছে। সর্বশেষ list দেখানো হচ্ছে — দেখে নিয়ে প্রয়োজনে আবার Clear করুন।': 'This list was just changed on another device. Showing the latest list — check it and clear again if needed.',
    'এই কাজের অনুমতি আপনার নেই।': 'You are not allowed to do this.',
    'একবারে অনেক বেশি পরিবর্তন। কয়েক ধাপে করুন।': 'Too many changes at once. Do it in a few steps.',
    'Search-এর তথ্য সঠিক নয়।': 'The search input is not valid.',
    'এই list জমা দেওয়া বা lock করা আছে, তাই এখন বদলানো যাবে না।': 'This list is submitted or locked, so it cannot be changed now.',
    'যথেষ্ট Supervisor-এর নাম দেওয়া হয়নি।': 'Not enough supervisor names given.',
    'এই Work Name-এ আপনার আরেকটা list আছে। অন্য নাম দিন।': 'You already have a list with this Work Name. Use another name.',
    'List-এ worker আছে। মোছার আগে Clear Selected করুন।': 'The list has workers. Clear them before deleting.',
    '③ Supervisor ও List-এর তথ্য': '③ Supervisor and list details',
    '📝 খসড়া — worker বাছাই শেষ হলে "Next" চাপুন': '📝 Draft — tap "Next" when you finish picking workers',
    'এক column: খুঁজুন / বাছাই tab, বড় row': 'One column: Search / Picked tabs, big rows',
    'আগে worker বাছুন, তারপর Next চাপুন।': 'Pick workers first, then tap Next.',
    'Save হয়েছে। Next-এর আগে': 'Saved. Before Next, give',
    'জন Supervisor-এর নাম দিন (দেওয়া আছে': 'supervisor name(s) (given',
    'টা · Draft ': ' · Draft ',
    '① Work Name ও Work Code': '① Work Name and Work Code',
    'Save, Next: ② Worker →': 'Save, Next: ② Worker →',
    'List খুলুন, Next: ② Worker →': 'Open list, Next: ② Worker →',
    '③ Supervisor-এর নাম': '③ Supervisor names',
    'জন Supervisor লাগবে।': 'supervisor(s) needed.',
    'এখন ': 'Now ',
    'একসঙ্গে সর্বোচ্চ ৩টা Draft list রাখা যায়। আগে একটা Draft Submit করুন অথবা 🗑 দিয়ে মুছুন।': 'At most 3 Draft lists at a time. Submit a draft first, or delete one with 🗑.',
    'আপনার ৩টা Draft list আছে। Edit করার আগে একটা Draft Submit করুন অথবা মুছুন।': 'You have 3 Draft lists. Submit or delete a draft before editing this one.',
    'List মুছুন': 'Delete list',
    'বাছাই করা ': 'Remove the ',
    ' জন worker সরিয়ে দেবেন?': ' selected worker(s)?',
    'List থাকবে, শুধু worker বাছাই খালি হবে।': 'The list stays, only the selection is cleared.',
    'হ্যাঁ, খালি করুন': 'Yes, clear',
    'হ্যাঁ, মুছুন': 'Yes, delete',
    'হ্যাঁ, জমা দিন': 'Yes, submit',
    ' list মুছবেন?': ' — delete this list?',
    ' list জমা দেবেন?': ' — submit this list?',
    ' জন worker সহ Admin-এর কাছে যাবে।': ' worker(s) will go to the admin.',
    'পরে বদলাতে হলে "↩ Edit" চাপতে হবে।': 'To change it later, tap "↩ Edit".',
    'এতে ': 'It has ',
    ' জন worker আছে। মুছলে এরা আবার নতুন list-এ নেওয়া যাবে।': ' worker(s). After deleting, they can be added to a new list again.',
    'List-টা জমা দেওয়া আছে, মুছলে Admin-এর কাছেও আর দেখাবে না।': 'This list is submitted; after deleting, the admin will not see it either.',
    'নাম (ইংরেজিতে)': 'Name (in English)',
    'যেমন: Arup Roy': 'e.g. Arup Roy',
    'বাদ দিন': 'Remove',
    'Work Code নেই': 'No Work Code',
    // small words (applied last)
    'জন।': '.',
    'জন)।': ').',
    'জন ·': '·',
    'জন worker →': 'workers →',
    'জন': ''
  };
  // short words: only when they are the whole text of a node
  var EXACT = { 'না': 'No', 'হ্যাঁ': 'Yes', '২.': '2. Choose', 'বাছুন।': '.', 'চাপুন।': 'at the top right.', 'নেই': 'none', 'বন্ধ': 'Close',
                'জমা দেওয়া': 'Submitted', 'নাম': 'Name', 'অন্য': 'another', 'জমা': 'submitted', 'বা': 'or' };
  var BN_DIGITS = '০১২৩৪৫৬৭৮৯';
  // the same Bengali letter can be stored in two ways (e.g. য়), so compare in one form
  function nf(x) { return x.normalize ? x.normalize('NFC') : x; }
  var N = {}; Object.keys(D).forEach(function (k) { N[nf(k)] = D[k]; }); D = N;
  var E2 = {}; Object.keys(EXACT).forEach(function (k) { E2[nf(k)] = EXACT[k]; }); EXACT = E2;
  var keys = Object.keys(D).sort(function (a, b) { return b.length - a.length; });
  var HAS_BN = /[ঀ-৿]/;
  function tr(text) {
    if (!text || !HAS_BN.test(text)) return text;
    text = nf(text);
    var tt = text.trim(); if (EXACT[tt]) return text.replace(tt, EXACT[tt]);
    var out = text;
    for (var i = 0; i < keys.length; i++) if (out.indexOf(keys[i]) >= 0) out = out.split(keys[i]).join(D[keys[i]]);
    out = out.replace(/[০-৯]/g, function (d) { return String(BN_DIGITS.indexOf(d)); });
    return out.replace(/ {2,}/g, ' ');
  }
  function skip(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    return !el || !!el.closest('#userGuideModal, script, style, textarea');
  }
  function walk(root) {
    if (skip(root)) return;
    if (root.nodeType === 3) { var t = tr(root.nodeValue); if (t !== root.nodeValue) root.nodeValue = t; return; }
    if (root.nodeType !== 1) return;
    ['placeholder', 'title', 'aria-label'].forEach(function (a) {
      var v = root.getAttribute(a); if (v && HAS_BN.test(v)) root.setAttribute(a, tr(v));
    });
    for (var c = root.firstChild; c; c = c.nextSibling) walk(c);
  }

  function addSwitch() {
    var h = document.querySelector('.header'); if (!h || document.getElementById('langSwitch')) return;
    h.style.position = 'relative';
    var w = document.createElement('div'); w.id = 'langSwitch'; w.className = 'lang-switch';
    w.innerHTML = '<button type="button" data-l="en">EN</button><button type="button" data-l="bn">বাং</button>';
    w.querySelectorAll('button').forEach(function (b) {
      if (b.getAttribute('data-l') === lang) b.className = 'on';
      b.addEventListener('click', function () {
        var l = b.getAttribute('data-l'); if (l === lang) return;
        try { localStorage.setItem(KEY, l); } catch (e) {}
        location.reload();
      });
    });
    h.appendChild(w);
    var st = document.createElement('style');
    st.textContent = '.lang-switch{position:absolute;top:10px;right:10px;display:flex;background:rgba(255,255,255,.12);border-radius:20px;padding:2px;}' +
      '.lang-switch button{border:0;background:none;color:#cbd5e1;font-weight:800;font-size:12px;padding:4px 10px;border-radius:16px;cursor:pointer;}' +
      '.lang-switch button.on{background:#fff;color:#0f172a;}.header-title{padding-right:92px;}';
    document.head.appendChild(st);
  }

  addSwitch();
  if (lang !== 'en') return;
  document.documentElement.lang = 'en';
  walk(document.body);
  new MutationObserver(function (list) {
    list.forEach(function (m) {
      if (m.type === 'characterData') { if (!skip(m.target)) { var t = tr(m.target.nodeValue); if (t !== m.target.nodeValue) m.target.nodeValue = t; } }
      else if (m.type === 'attributes') { walk(m.target); }
      else m.addedNodes.forEach(walk);
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
  var c0 = window.confirm.bind(window), a0 = window.alert.bind(window);
  window.confirm = function (m) { return c0(tr(String(m))); };
  window.alert = function (m) { return a0(tr(String(m))); };
})();
