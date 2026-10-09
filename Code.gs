const USERS_SHEET = 'USERS';
const WORKERS_SHEET = 'WORKER';
const ACCOUNT_SHEET = 'ACCOUNT';
const GP_SHEET = 'GP_MASTER';
const SELECTION_SHEET = 'SELECTIONS';

const GP_CODES = {
  'Bara Atiabari-I': '001',
  'Petla': '014'
};

function doGet(e){
  if (e && e.parameter && e.parameter.api === '1') return apiGet_(e);
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('G RAM-G 4A/Demand List Builder')
    .addMetaTag('viewport','width=device-width, initial-scale=1');
}

// External PWA API bridge. Keep the existing sheet functions and business logic unchanged.
function doPost(e){
  var payload = {};
  try { payload = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch(err) { return ContentService.createTextOutput('Invalid JSON'); }
  var requestId = String(payload.requestId || '');
  if (!/^[a-zA-Z0-9_-]{10,100}$/.test(requestId)) return ContentService.createTextOutput('Invalid request ID');
  var result;
  try {
    var a = Array.isArray(payload.args) ? payload.args : [];
    switch (String(payload.action || '')) {
      case 'login': result = login(a[0], a[1]); break;
      case 'getVillages': result = getVillages(a[0]); break;
      case 'getFamilies': result = getFamilies(a[0], a[1]); break;
      case 'saveSelection': result = saveSelection(a[0], a[1]); break;
      case 'clearSavedSelection': result = clearSavedSelection(a[0]); break;
      case 'getSavedWorkers': result = getSavedWorkers(a[0]); break;
      case 'getAccounts': result = getAccounts(a[0], a[1]); break;
      default: throw new Error('Unknown API action');
    }
    CacheService.getScriptCache().put('GRAMG_API_' + requestId, JSON.stringify({ok:true, data:result}), 60);
  } catch(err) {
    CacheService.getScriptCache().put('GRAMG_API_' + requestId, JSON.stringify({ok:false, error:String(err && err.message ? err.message : err)}), 60);
  }
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

function apiGet_(e){
  var callback = String((e.parameter && e.parameter.callback) || '');
  if (!/^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(callback)) return ContentService.createTextOutput('Invalid callback');
  var requestId = String((e.parameter && e.parameter.requestId) || '');
  if (!/^[a-zA-Z0-9_-]{10,100}$/.test(requestId)) return ContentService.createTextOutput(callback + '({\"ok\":false,\"error\":\"Invalid request ID\"})').setMimeType(ContentService.MimeType.JAVASCRIPT);
  var cache = CacheService.getScriptCache();
  var key = 'GRAMG_API_' + requestId;
  var raw = cache.get(key);
  var response;
  if (!raw) response = {pending:true};
  else { response = JSON.parse(raw); cache.remove(key); }
  return ContentService.createTextOutput(callback + '(' + JSON.stringify(response) + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
}


function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }

function sheetData_(name){
  const sh=ss_().getSheetByName(name);
  if(!sh) throw new Error('Sheet not found: '+name);
  const values=sh.getDataRange().getDisplayValues();
  if(!values.length) return [];
  const headers=values.shift().map(String);
  return values.map(row=>{
    const obj={};
    headers.forEach((h,i)=>obj[h.trim()]=row[i]==null?'':String(row[i]).trim());
    return obj;
  });
}

function login(username,pin){
  username=String(username||'').trim(); pin=String(pin||'').trim();
  if(!username||!pin) return {ok:false,message:'Username এবং PIN দিন।'};
  const user=sheetData_(USERS_SHEET).find(u=>String(u.Username).trim()===username && String(u.PIN).trim()===pin && /^(yes|true|1)$/i.test(String(u.Active).trim()));
  if(!user) return {ok:false,message:'Username/PIN ভুল অথবা user inactive।'};
  const token=Utilities.getUuid();
  CacheService.getScriptCache().put('LB_'+token,JSON.stringify({username:user.Username,gp:user.GP,name:user.Name}),21600);
  return {ok:true,token,user:{username:user.Username,name:user.Name,gp:user.GP}};
}

function auth_(token){
  const raw=CacheService.getScriptCache().get('LB_'+String(token||''));
  if(!raw) throw new Error('Session expired. আবার login করুন।');
  return JSON.parse(raw);
}

function getGpCode_(gpName){
  const name=String(gpName||'').trim();
  const master=ss_().getSheetByName(GP_SHEET);
  if(master && master.getLastRow()>1){
    const rows=master.getDataRange().getDisplayValues();
    const headers=rows.shift().map(String);
    const ni=headers.findIndex(h=>h.trim().toLowerCase()==='gp name');
    const ci=headers.findIndex(h=>h.trim().toLowerCase()==='gp code');
    if(ni>=0&&ci>=0){
      const hit=rows.find(r=>String(r[ni]).trim().toLowerCase()===name.toLowerCase());
      if(hit) return String(hit[ci]).trim().padStart(3,'0');
    }
  }
  if(GP_CODES[name]) return GP_CODES[name];
  const normalized=name.toLowerCase().replace(/[^a-z0-9]/g,'');
  if(normalized==='baraatiabarii'||normalized==='baroatiabarii') return '001';
  if(normalized==='petla') return '014';
  return '';
}

function parseJobCard_(jobCard){
  const value=String(jobCard||'').trim().toUpperCase();
  const m=value.match(/^WB-\d{2}-\d{3}-(\d{3})-(\d{3})\/(\d+)$/i);
  if(!m) return null;
  return {gpCode:m[1],village:Number(m[2]),household:Number(m[3]),jobCard:value};
}
function normalizeJobCard_(v){ return String(v||'').trim().toUpperCase(); }
function truthy_(v){ return /^(yes|true|1|y|✓)$/i.test(String(v||'').trim()); }

function getVillages(token){
  const user=auth_(token), gpCode=getGpCode_(user.gp);
  if(!gpCode) throw new Error('এই GP-এর code পাওয়া যায়নি: '+user.gp);
  const map={};
  sheetData_(WORKERS_SHEET).forEach(row=>{
    const p=parseJobCard_(normalizeJobCard_(row['Job Card No']));
    if(!p||p.gpCode!==gpCode) return;
    map[p.village]||(map[p.village]={v:p.village,families:{}});
    map[p.village].families[p.household]=true;
  });
  return Object.keys(map).map(k=>({v:map[k].v,families:Object.keys(map[k].families).length})).sort((a,b)=>a.v-b.v);
}

function getFamilies(token,entries){
  const user=auth_(token), gpCode=getGpCode_(user.gp);
  if(!gpCode) throw new Error('এই GP-এর code পাওয়া যায়নি।');
  const wantedOrder=[], wanted={};
  (Array.isArray(entries)?entries:[]).forEach(e=>{
    const v=String(e.v).replace(/^0+/,'')||'0', h=String(e.h).replace(/^0+/,'')||'0', k=v+'/'+h;
    if(!wanted[k]){wanted[k]=true;wantedOrder.push(k);}
  });
  const families={};
  sheetData_(WORKERS_SHEET).forEach(row=>{
    const jobCard=normalizeJobCard_(row['Job Card No']), p=parseJobCard_(jobCard);
    if(!p||p.gpCode!==gpCode) return;
    const key=p.village+'/'+p.household;
    if(!wanted[key]) return;
    if(!families[key]) families[key]={key,village:p.village,household:p.household,jobCard,members:[]};
    families[key].members.push({
      id:jobCard+'|'+String(row['Applicant No']||''), jobCard,
      applicantNo:String(row['Applicant No']||''), name:String(row['Applicant Name']||''),
      ekyc:truthy_(row['eKYC']), abps:truthy_(row['ABPS']),
      aadhaarSeeded:truthy_(row['Aadhaar Seeded']), authenticationDone:truthy_(row['Authentication Done'])
    });
  });
  return wantedOrder.filter(k=>families[k]).map(k=>families[k]);
}

function makeCsv(token,selected){
  const user=auth_(token), wanted=Array.isArray(selected)?selected:[];
  if(!wanted.length) throw new Error('কোনো worker select করা হয়নি।');
  const gpCode=getGpCode_(user.gp), byId={};
  sheetData_(WORKERS_SHEET).forEach(row=>{
    const jobCard=normalizeJobCard_(row['Job Card No']), p=parseJobCard_(jobCard);
    if(!p||p.gpCode!==gpCode) return;
    byId[jobCard+'|'+String(row['Applicant No']||'')]=row;
  });
  const output=[['Reg No','Applicant']];
  wanted.forEach(item=>{const row=byId[String(item.id||'')]; if(row) output.push([row['Job Card No'],row['Applicant Name']]);});
  if(output.length<=1) throw new Error('Selected worker পাওয়া যায়নি।');
  return {gp:String(user.gp),count:output.length-1,rows:output};
}

function ensureSheet_(name,headers){
  let sh=ss_().getSheetByName(name);
  if(!sh) sh=ss_().insertSheet(name);
  if(sh.getLastRow()===0) sh.appendRow(headers);
  return sh;
}

function setupSheets(){
  ensureSheet_(USERS_SHEET,['Username','PIN','Name','GP','Active']);
  ensureSheet_(WORKERS_SHEET,['Job Card No','Applicant No','Applicant Name','Aadhaar Seeded','Authentication Done','ABPS','eKYC']);
  const gp=ensureSheet_(GP_SHEET,['GP Name','GP Code']);
  const gpRows=gp.getDataRange().getDisplayValues().map(r=>r[0]);
  if(!gpRows.includes('Bara Atiabari-I')) gp.appendRow(['Bara Atiabari-I','001']);
  if(!gpRows.includes('Petla')) gp.appendRow(['Petla','014']);
  ensureSheet_(ACCOUNT_SHEET,['Job Card No','Applicant No','Account No','IFSC Code']);
  ensureSheet_(SELECTION_SHEET,['Username','GP','Job Card No','Applicant No','Saved At']);
  return 'Setup complete';
}

function getSavedSelection(token){
  const user=auth_(token), sh=ss_().getSheetByName(SELECTION_SHEET);
  if(!sh||sh.getLastRow()<2) return [];
  const rows=sheetData_(SELECTION_SHEET).filter(r=>String(r.Username)===String(user.username)&&String(r.GP)===String(user.gp));
  return rows.map(r=>({id:String(r['Job Card No'])+'|'+String(r['Applicant No']),jobCard:String(r['Job Card No']),applicantNo:String(r['Applicant No'])}));
}

function saveSelection(token,items){
  const user=auth_(token), sh=ensureSheet_(SELECTION_SHEET,['Username','GP','Job Card No','Applicant No','Saved At']);
  const data=sh.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--) if(String(data[i][0])===String(user.username)&&String(data[i][1])===String(user.gp)) sh.deleteRow(i+1);
  const list=Array.isArray(items)?items:[];
  if(list.length){
    const now=new Date(); sh.getRange(sh.getLastRow()+1,1,list.length,5).setValues(list.map(x=>[user.username,user.gp,String(x.jobCard||''),String(x.applicantNo||''),now]));
  }
  return {ok:true,count:list.length};
}

function clearSavedSelection(token){
  const user=auth_(token), sh=ss_().getSheetByName(SELECTION_SHEET);
  if(!sh||sh.getLastRow()<2) return true;
  const data=sh.getDataRange().getValues();
  for(let i=data.length-1;i>=1;i--) if(String(data[i][0])===String(user.username)&&String(data[i][1])===String(user.gp)) sh.deleteRow(i+1);
  return true;
}

function getSavedWorkers(token){
  const user=auth_(token), saved=getSavedSelection(token);
  if(!saved.length) return [];
  const gpCode=getGpCode_(user.gp), byId={};
  sheetData_(WORKERS_SHEET).forEach(row=>{
    const jc=normalizeJobCard_(row['Job Card No']), p=parseJobCard_(jc); if(!p||p.gpCode!==gpCode)return;
    const id=jc+'|'+String(row['Applicant No']||'');
    byId[id]={id,jobCard:jc,applicantNo:String(row['Applicant No']||''),name:String(row['Applicant Name']||''),ekyc:truthy_(row['eKYC']),abps:truthy_(row['ABPS']),aadhaarSeeded:truthy_(row['Aadhaar Seeded']),authenticationDone:truthy_(row['Authentication Done'])};
  });
  return saved.map(s=>byId[s.id]).filter(Boolean);
}

function getAccounts(token,ids){
  auth_(token); const sh=ss_().getSheetByName(ACCOUNT_SHEET); if(!sh||sh.getLastRow()<2) return {};
  const headers=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(String);
  const find=h=>headers.findIndex(x=>x.trim().toLowerCase()===h.toLowerCase());
  const ji=find('Job Card No'), ai=find('Applicant No'), ac=find('Account No'), fi=Math.max(find('IFSC Code'),find('IFSC'));
  if(ji<0||ai<0) return {};
  const wanted={}; (Array.isArray(ids)?ids:[]).forEach(id=>wanted[String(id)]=true); const out={};
  sh.getRange(2,1,Math.max(0,sh.getLastRow()-1),sh.getLastColumn()).getDisplayValues().forEach(r=>{
    const key=String(r[ji]).trim().toUpperCase()+'|'+String(r[ai]).trim(); if(!wanted[key]) return;
    out[key]={accountNo:ac>=0?String(r[ac]).trim():'',ifsc:fi>=0?String(r[fi]).trim():''};
  });
  return out;
}
