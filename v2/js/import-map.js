/* =====================================================================
   Import column mapping: turns any of the known header spellings into the
   canonical keys the database expects. Only these 9 columns are sent to the
   server — every other column in the file (caste, gender, age, Aadhaar name,
   …) is ignored on purpose.
   ===================================================================== */
(function (root) {
  'use strict';
  var ALIASES = {
    job_card_no:         ['job card no', 'job card number', 'jobcard no', 'job card', 'reg no', 'registration no'],
    applicant_no:        ['applicant no', 'applicant number', 'applicant id'],
    applicant_name:      ['applicant name', 'applicant', 'name of applicant'],
    aadhaar_seeded:      ['aadhaar seeded', 'aadhar seeded'],
    authentication_done: ['authentication done', 'authentication'],
    abps:                ['abps', 'enabled for abps', 'abps enabled'],
    ekyc:                ['ekyc', 'ekyc done', 'e kyc', 'e-kyc'],
    account_no:          ['account no', 'account number', 'a/c no', 'ac no', 'bank account no'],
    ifsc:                ['ifsc', 'ifsc code']
  };
  var LABELS = {
    job_card_no: 'Job Card No', applicant_no: 'Applicant No', applicant_name: 'Applicant Name',
    aadhaar_seeded: 'Aadhaar Seeded', authentication_done: 'Authentication Done', abps: 'ABPS',
    ekyc: 'eKYC', account_no: 'Account No', ifsc: 'IFSC'
  };
  var REQUIRED = ['job_card_no', 'applicant_no'];

  function norm(h) {
    return String(h == null ? '' : h).replace(/^﻿/, '').toLowerCase()
      .replace(/[?.:]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // headers: array of header cells -> { map: {canonical: index}, missing: [...], ignored: [...] }
  function mapHeaders(headers) {
    var map = {}, used = {};
    headers.forEach(function (h, i) {
      var n = norm(h);
      Object.keys(ALIASES).forEach(function (key) {
        if (map[key] === undefined && ALIASES[key].indexOf(n) >= 0) { map[key] = i; used[i] = true; }
      });
    });
    return {
      map: map,
      missing: REQUIRED.filter(function (k) { return map[k] === undefined; }),
      found: Object.keys(map),
      ignored: headers.filter(function (h, i) { return !used[i] && norm(h) !== ''; })
    };
  }

  // rows: array of arrays (header row excluded); firstRowNo = Excel row number of rows[0]
  function toRaw(rows, map, firstRowNo) {
    var out = [];
    rows.forEach(function (r, idx) {
      if (!r || r.every(function (c) { return String(c == null ? '' : c).trim() === ''; })) return;
      var raw = {};
      Object.keys(map).forEach(function (k) {
        var v = r[map[k]];
        raw[k] = v == null ? '' : String(v).trim();
      });
      out.push({ row_no: firstRowNo + idx, raw: raw });
    });
    return out;
  }

  var api = { mapHeaders: mapHeaders, toRaw: toRaw, LABELS: LABELS, REQUIRED: REQUIRED, norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GramgImportMap = api;
})(this);
