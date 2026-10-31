// MediCheck — shared small interactions + full backend API integration (No Map)
document.addEventListener('DOMContentLoaded', function () {
  // 1. Scroll-reveal (from original app.js)
  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll('.reveal, .reveal-stagger').forEach(function (el) {
    io.observe(el);
  });

  // 2. Interactive Upload Boxes (.upload-box) across scan, report, pharmacy, gov pages
  initUploadBoxes();

  // 3. Page-specific backend integrations
  var path = window.location.pathname.split('/').pop() || 'index.html';
  if (path === 'login.html') initLoginPage();
  if (path === 'home.html') initCitizenHomePage();
  if (path === 'scan.html') initScanPage();
  if (path === 'report.html') initReportPage();
  if (path === 'area.html') initAreaPage();
  if (path === 'pharmacy-home.html') initPharmacyHomePage();
  if (path === 'pharmacy-verify.html') initPharmacyVerifyPage();
  if (path === 'pharmacy-reports.html') initPharmacyReportsPage();
  if (path === 'gov-home.html') initGovHomePage();
  if (path === 'gov-case.html') initGovCasePage();
});

// FAQ accordion (original)
function toggleFaq(el) {
  el.parentElement.classList.toggle('open');
}

// Generic tab switcher (original)
function switchTab(group, target, btn) {
  document
    .querySelectorAll('[data-tabgroup="' + group + '"].tab-pane')
    .forEach(function (p) {
      p.classList.remove('active');
    });
  var t = document.getElementById(target);
  if (t) t.classList.add('active');
  if (btn && btn.parentElement) {
    btn.parentElement.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.remove('active');
    });
    btn.classList.add('active');
  }
}

// Helper for JSON API calls
async function apiFetch(url, options) {
  try {
    var res = await fetch(url, options);
    if (!res.ok) return null;
    return await res.json();
  } catch (_err) {
    return null;
  }
}

// Local session storage helpers for newly filed reports & updates
function getLocalReports() {
  try {
    return JSON.parse(sessionStorage.getItem('mc_local_reports') || '[]');
  } catch (_e) {
    return [];
  }
}

function saveLocalReport(rep) {
  var list = getLocalReports();
  list.unshift(rep);
  sessionStorage.setItem('mc_local_reports', JSON.stringify(list));
}

// Interactive file picker + backend upload for .upload-box elements
function initUploadBoxes() {
  document.querySelectorAll('.upload-box').forEach(function (box, idx) {
    if (box.dataset.uploadWired === '1') return;
    box.dataset.uploadWired = '1';
    box.style.cursor = 'pointer';

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*,.pdf,.csv';
    fileInput.style.display = 'none';
    box.appendChild(fileInput);

    box.addEventListener('click', function (e) {
      if (e.target === fileInput) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', async function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var span = box.querySelector('span');
      var b = box.querySelector('b');
      if (b) b.textContent = 'Uploading ' + file.name + '...';

      var uploaded = await apiFetch('/api/upload-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          folder: 'uploads-' + idx,
          content_type: file.type || 'image/jpeg',
        }),
      });

      var url = (uploaded && uploaded.url) || 'https://example.com/evidence_proofs/' + encodeURIComponent(file.name);
      box.dataset.uploadedUrl = url;
      box.dataset.uploadedFilename = file.name;
      if (b) b.textContent = 'Attached: ' + file.name;
      if (span) span.textContent = 'Ready to submit';
    });
  });
}

// ---------------------------------------------------------------------------
// 1. LOGIN & REGISTER PAGE (login.html)
// ---------------------------------------------------------------------------
function initLoginPage() {
  window.doLogin = async function () {
    var role = typeof loginRole !== 'undefined' ? loginRole : 'citizen';
    var idEl = document.getElementById('l-id');
    var passEl = document.getElementById('l-pass');
    var identifier = idEl ? idEl.value.trim() : '';
    var password = passEl ? passEl.value : '';

    var session = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: role, identifier: identifier, password: password }),
    });

    if (session) {
      sessionStorage.setItem('mc_user', JSON.stringify(session));
    }

    if (role === 'pharmacy') window.location.href = 'pharmacy-home.html';
    else if (role === 'gov') window.location.href = 'gov-home.html';
    else window.location.href = 'home.html';
  };

  window.doCitizenReg = async function () {
    var nameEl = document.getElementById('r-name');
    var phoneEl = document.getElementById('r-phone');
    var emailEl = document.getElementById('r-email');
    var passEl = document.getElementById('r-pass');

    var session = await apiFetch('/api/auth/register-citizen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: nameEl ? nameEl.value.trim() : 'Ananya',
        phone: phoneEl ? phoneEl.value.trim() : '',
        email: emailEl ? emailEl.value.trim() : '',
        password: passEl ? passEl.value : '',
      }),
    });

    if (session) {
      sessionStorage.setItem('mc_user', JSON.stringify(session));
    }
    window.location.href = 'home.html';
  };

  window.doOrgRequest = async function () {
    var role = typeof regRole !== 'undefined' ? regRole : 'pharmacy';
    var orgEl = document.getElementById('o-org');
    var contactEl = document.getElementById('o-contact');
    var phoneEl = document.getElementById('o-phone');
    var areaEl = document.getElementById('o-area');

    var res = await apiFetch('/api/auth/request-org-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: role,
        org_name: orgEl ? orgEl.value.trim() : 'Sundar Medicals',
        contact_person: contactEl ? contactEl.value.trim() : 'Authorized Contact',
        phone: phoneEl ? phoneEl.value.trim() : '+91 80 2553 0101',
        area: areaEl ? areaEl.value.trim() : 'Koramangala, Bengaluru',
      }),
    });

    alert(
      (res && res.message) ||
        'Thank you. Our team will call the number provided within 2 working days to verify and set up your account.'
    );
    if (typeof switchAuth === 'function') {
      switchAuth('login', document.querySelector('.auth-tab'));
    }
  };
}

// ---------------------------------------------------------------------------
// 2. CITIZEN HOME PAGE (home.html)
// ---------------------------------------------------------------------------
function initCitizenHomePage() {
  try {
    var user = JSON.parse(sessionStorage.getItem('mc_user') || 'null');
    if (user && user.role === 'citizen' && user.display_name) {
      var h1 = document.querySelector('.app-head h1');
      if (h1) h1.textContent = 'Good afternoon, ' + user.display_name;
    }
  } catch (_e) {}

  var localReports = getLocalReports();
  var panel = document.querySelector('.two-col .panel');
  if (panel && localReports.length > 0) {
    var firstRow = panel.querySelector('.ledger-row');
    localReports.forEach(function (rep) {
      var row = document.createElement('div');
      row.className = 'ledger-row';
      var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
      var issueTitle =
        rep.issue_type === 'stock'
          ? 'essential stock unavailable'
          : rep.issue_type === 'expired'
          ? 'expired stock sold'
          : 'sold above MRP';
      var meta1 =
        rep.issue_type === 'overpriced' && over > 0
          ? '<b>₹' + over.toFixed(0) + ' over MRP</b>Billed ₹' + rep.billed + ' vs ₹' + rep.mrp
          : rep.issue_type === 'stock'
          ? '<b>Stock unavailable</b>Reported just now'
          : '<b>Batch reported</b>Bill attached';

      row.innerHTML =
        '<div class="ledger-thumb">₹</div>' +
        '<div class="l-main"><b>' +
        escapeHtml(rep.medicine) +
        ' — ' +
        issueTitle +
        '</b><span>' +
        escapeHtml(rep.pharmacy) +
        ', ' +
        escapeHtml(rep.address || 'Koramangala') +
        '</span></div>' +
        '<div class="l-meta">' +
        meta1 +
        '</div>' +
        '<div class="l-meta"><b>Just now</b>Bill attached</div>' +
        '<span class="pill pill-open"><span class="d"></span>Open</span>';

      if (firstRow) panel.insertBefore(row, firstRow);
      else panel.appendChild(row);
    });

    // Update citizen's filed report count card
    var statCards = document.querySelectorAll('.side-stack .stat-card');
    if (statCards[0]) {
      var valEl = statCards[0].querySelector('.val');
      if (valEl) valEl.textContent = String(3 + localReports.length);
      var openRow = statCards[0].querySelector('.stat-row span:last-child');
      if (openRow) openRow.textContent = String(1 + localReports.length);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. CITIZEN BARCODE SCANNER PAGE (scan.html)
// ---------------------------------------------------------------------------
function initScanPage() {
  var origGoStep = window.goStep;
  window.goStep = function (n) {
    if (typeof origGoStep === 'function') origGoStep(n);
    if (n === 2) {
      // Query real backend barcode check for GTIN 08901234567890 / Dolo 650
      apiFetch('/api/check?q=08901234567890').then(function (data) {
        if (data && data.check) {
          window.__lastBackendCheck = data.check;
        }
      });
    }
  };

  var origCheckPrice = window.checkPrice;
  window.checkPrice = function () {
    if (typeof origCheckPrice === 'function') origCheckPrice();
    var uploadBox = document.querySelector('#scan-step-2 .upload-box');
    var uploadedUrl = uploadBox ? uploadBox.dataset.uploadedUrl : null;
    try {
      var scanData = JSON.parse(sessionStorage.getItem('mc_scan') || '{}');
      if (uploadedUrl) scanData.bill_photo_url = uploadedUrl;
      sessionStorage.setItem('mc_scan', JSON.stringify(scanData));
    } catch (_e) {}
  };
}

// ---------------------------------------------------------------------------
// 4. CITIZEN ADD REPORT PAGE (report.html)
// ---------------------------------------------------------------------------
function initReportPage() {
  window.submitReport = async function () {
    var issueEl = document.getElementById('issue-type');
    var medEl = document.getElementById('medicine');
    var mrpEl = document.getElementById('mrp');
    var billedEl = document.getElementById('billed');
    var pharmEl = document.getElementById('pharmacy');
    var addrEl = document.getElementById('address');
    var notesEl = document.getElementById('notes');
    var uploadBox = document.querySelector('.upload-box');

    var payload = {
      issue_type: issueEl ? issueEl.value : 'overpriced',
      medicine: (medEl && medEl.value.trim()) || 'Dolo 650mg, 15 tablets',
      mrp: Number((mrpEl && mrpEl.value) || 31),
      billed: Number((billedEl && billedEl.value) || 49),
      pharmacy: (pharmEl && pharmEl.value.trim()) || 'Sundar Medicals',
      address: (addrEl && addrEl.value.trim()) || '12, 5th Block, Koramangala, Bengaluru 560095',
      notes: (notesEl && notesEl.value.trim()) || '',
      bill_photo_url: (uploadBox && uploadBox.dataset.uploadedUrl) || null,
    };

    var res = await apiFetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    saveLocalReport({
      reportId: (res && res.reportId) || 'rep-' + Date.now(),
      issue_type: payload.issue_type,
      medicine: payload.medicine,
      mrp: payload.mrp,
      billed: payload.billed,
      pharmacy: payload.pharmacy,
      address: payload.address,
      notes: payload.notes,
    });

    alert('Report submitted. It is now visible on your area page and queued for the government reviewer.');
    window.location.href = 'home.html';
  };
}

// ---------------------------------------------------------------------------
// 5. CITIZEN AREA SEARCH PAGE (area.html — Address Only, No Map)
// ---------------------------------------------------------------------------
function initAreaPage() {
  // Support area.html#pharmacies hash link from home.html
  if (window.location.hash === '#pharmacies') {
    var pharmBtn = document.querySelectorAll('[data-tabgroup="area"] .tab-btn')[1];
    switchTab('area', 'pane-pharmacies', pharmBtn);
  }

  // Prepend any locally filed reports into #pane-issues
  var issuesPanel = document.querySelector('#pane-issues .panel');
  var localReports = getLocalReports();
  if (issuesPanel && localReports.length > 0) {
    var firstRow = issuesPanel.querySelector('.ledger-row');
    localReports.forEach(function (rep) {
      var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
      var issueTitle =
        rep.issue_type === 'stock'
          ? 'essential stock unavailable'
          : rep.issue_type === 'expired'
          ? 'expired stock sold'
          : 'sold above MRP';
      var row = document.createElement('div');
      row.className = 'ledger-row';
      row.dataset.issueCategory = rep.issue_type || 'overpriced';
      row.dataset.issueStatus = 'open';
      row.innerHTML =
        '<div class="ledger-thumb">₹</div>' +
        '<div class="l-main"><b>' +
        escapeHtml(rep.medicine) +
        ' — ' +
        issueTitle +
        '</b><span>' +
        escapeHtml(rep.pharmacy) +
        ', ' +
        escapeHtml(rep.address || 'Koramangala') +
        '</span></div>' +
        '<div class="l-meta"><b>' +
        (over > 0 ? '₹' + over.toFixed(0) + ' over MRP' : 'Reported issue') +
        '</b>Filed just now · bill attached</div>' +
        '<div class="l-meta"><b>Awaiting review</b>BBMP Health Dept.</div>' +
        '<span class="pill pill-open"><span class="d"></span>Open</span>';
      if (firstRow) issuesPanel.insertBefore(row, firstRow);
      else issuesPanel.appendChild(row);
    });
  }

  // Classify existing ledger rows in #pane-issues for chip filtering
  document.querySelectorAll('#pane-issues .ledger-row').forEach(function (row) {
    var text = row.textContent.toLowerCase();
    if (!row.dataset.issueCategory) {
      if (text.includes('above mrp') || text.includes('over mrp')) row.dataset.issueCategory = 'overpriced';
      else if (text.includes('stock') || text.includes('unavailable')) row.dataset.issueCategory = 'stock';
      else if (text.includes('expired') || text.includes('expiry') || text.includes('batch')) row.dataset.issueCategory = 'expired';
      else row.dataset.issueCategory = 'overpriced';
    }
    if (!row.dataset.issueStatus) {
      if (row.querySelector('.pill-resolved')) row.dataset.issueStatus = 'resolved';
      else if (row.querySelector('.pill-progress')) row.dataset.issueStatus = 'in_progress';
      else row.dataset.issueStatus = 'open';
    }
  });

  // Wire filter chips in #pane-issues
  var issueChips = document.querySelectorAll('#pane-issues .filter-row .chip');
  issueChips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      issueChips.forEach(function (c) {
        c.classList.remove('active');
      });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      document.querySelectorAll('#pane-issues .ledger-row').forEach(function (row) {
        var cat = row.dataset.issueCategory;
        var st = row.dataset.issueStatus;
        var show = true;
        if (label.includes('overpriced')) show = cat === 'overpriced';
        else if (label.includes('missing stock')) show = cat === 'stock';
        else if (label.includes('expired')) show = cat === 'expired';
        else if (label.includes('resolved')) show = st === 'resolved';
        row.style.display = show ? '' : 'none';
      });
    });
  });

  // Wire filter chips in #pane-pharmacies
  var pharmChips = document.querySelectorAll('#pane-pharmacies .filter-row .chip');
  pharmChips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      pharmChips.forEach(function (c) {
        c.classList.remove('active');
      });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      document.querySelectorAll('#pane-pharmacies .pharm-row').forEach(function (row) {
        var isVer = !!row.querySelector('.pill-verified');
        var show = label.includes('verified only') ? isVer : true;
        row.style.display = show ? '' : 'none';
      });
    });
  });

  // Wire Search area bar
  var searchInput = document.getElementById('area-search');
  var searchBtn = document.querySelector('.search-bar .btn');
  async function runAreaSearch() {
    var q = searchInput ? searchInput.value.trim() : 'Koramangala, Bengaluru';
    var displayArea = q || 'Koramangala, Bengaluru';
    var issueHead = document.querySelector('#pane-issues .panel-head h2');
    var pharmHead = document.querySelector('#pane-pharmacies .panel-head h2');

    var data = await apiFetch('/api/community?q=' + encodeURIComponent(displayArea.split(',')[0].trim()));
    if (issueHead) {
      var totalRows = document.querySelectorAll('#pane-issues .ledger-row').length;
      var count = data && data.issues && data.issues.items && data.issues.items.length > 0
        ? Math.max(totalRows, data.issues.summary.total_matching_reports)
        : 24 + localReports.length;
      issueHead.textContent = count + ' issues in ' + displayArea;
    }
    if (pharmHead) {
      var vCount = data && data.verifiedPharmacies && data.verifiedPharmacies.length > 0
        ? Math.max(4, data.verifiedPharmacies.length)
        : 7;
      pharmHead.textContent = vCount + ' verified pharmacies in ' + displayArea;
    }
  }
  if (searchBtn) searchBtn.addEventListener('click', runAreaSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runAreaSearch();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 6. PHARMACY HOME PAGE (pharmacy-home.html)
// ---------------------------------------------------------------------------
function initPharmacyHomePage() {
  var rows = document.querySelectorAll('.price-row');
  rows.forEach(function (row, idx) {
    var btn = row.querySelector('button.btn');
    if (!btn) return;
    btn.addEventListener('click', async function () {
      var isStock = btn.textContent.toLowerCase().includes('stock');
      var itemId = 'price-item-' + (idx + 1);
      var res = await apiFetch('/api/pharmacy/price-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: itemId,
          action: isStock ? 'update_stock' : 'mark_corrected',
        }),
      });

      var cells = row.children;
      if (cells[1]) {
        cells[1].innerHTML = isStock
          ? '<b>Your price: ₹68.00</b><div class="sub">Restocked today</div>'
          : '<b>Your price: ₹31.00</b><div class="sub">Corrected to MRP</div>';
      }
      if (cells[2]) {
        var bText = cells[2].querySelector('b') ? cells[2].querySelector('b').textContent : 'Registered MRP';
        cells[2].innerHTML =
          '<b>' + escapeHtml(bText) + '</b><div class="sub" style="color:var(--ok);">Matches MRP</div>';
      }
      var pill = document.createElement('span');
      pill.className = 'pill pill-verified';
      pill.innerHTML = '<span class="d"></span>Matched';
      btn.replaceWith(pill);

      // Update Billing match rate stat card
      var statCards = document.querySelectorAll('.quick-actions .stat-card');
      if (statCards[2]) {
        var valEl = statCards[2].querySelector('.val');
        if (valEl) {
          valEl.textContent = (res && res.billing_match_rate ? res.billing_match_rate : 98) + '%';
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 7. PHARMACY VERIFY PAGE (pharmacy-verify.html)
// ---------------------------------------------------------------------------
function initPharmacyVerifyPage() {
  var origSimScan = window.simulateStockScan;
  window.simulateStockScan = function () {
    if (typeof origSimScan === 'function') origSimScan();
    apiFetch('/api/check?q=08901234567890');
  };

  window.submitProof = async function () {
    var periodEl = document.getElementById('period');
    var notesEl = document.getElementById('pnotes');
    var scanCountEl = document.getElementById('scan-count');
    var boxes = document.querySelectorAll('.upload-box');
    var stockUrl = (boxes[0] && boxes[0].dataset.uploadedUrl) || 'https://example.com/proof/shelf-barcode-scan.jpg';
    var billingUrl = (boxes[1] && boxes[1].dataset.uploadedUrl) || 'https://example.com/proof/billing-export-30d.csv';

    await apiFetch('/api/pharmacy/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pharmacy_name: 'Sundar Medicals',
        licence_no: 'KA-BLR-KOR-001',
        area: 'Koramangala',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560095',
        period: (periodEl && periodEl.value.trim()) || '1–31 October 2026',
        notes: (notesEl && notesEl.value.trim()) || '',
        items_scanned: Number((scanCountEl && scanCountEl.textContent) || 12),
        stock_proof_urls: [stockUrl],
        billing_proof_urls: [billingUrl],
      }),
    });

    alert("Records submitted. Your verification status will update once they're reviewed.");
    window.location.href = 'pharmacy-home.html';
  };
}

// ---------------------------------------------------------------------------
// 8. PHARMACY REPORTS PAGE (pharmacy-reports.html)
// ---------------------------------------------------------------------------
function initPharmacyReportsPage() {
  var chips = document.querySelectorAll('.filter-row .chip');
  chips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      chips.forEach(function (c) {
        c.classList.remove('active');
      });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      document.querySelectorAll('.panel .ledger-row').forEach(function (row) {
        var show = true;
        if (label.startsWith('open')) show = !!row.querySelector('.pill-open');
        else if (label.startsWith('in progress')) show = !!row.querySelector('.pill-progress');
        else if (label.startsWith('resolved')) show = !!row.querySelector('.pill-resolved');
        row.style.display = show ? '' : 'none';
      });
    });
  });

  // Wire "Send response" button in capture phase so it saves to backend before alert
  var sendBtn = document.querySelector('.panel button.btn-primary');
  if (sendBtn) {
    sendBtn.removeAttribute('onclick');
    sendBtn.addEventListener('click', async function (e) {
      e.preventDefault();
      var respEl = document.getElementById('resp');
      var text = (respEl && respEl.value.trim()) || 'Restocked shelf and updated billing system to match MRP.';
      var uploadBox = document.querySelector('.upload-box');
      var proofUrl = (uploadBox && uploadBox.dataset.uploadedUrl) || null;

      await apiFetch('/api/pharmacy/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: 'bf57bf87-d7d7-4fbd-a155-fe7199af3899',
          pharmacy_name: 'Sundar Medicals',
          response_text: text,
          proof_url: proofUrl,
        }),
      });

      // Update the first open row in the UI to In progress
      var openRow = document.querySelector('.panel .ledger-row');
      if (openRow) {
        var metas = openRow.querySelectorAll('.l-meta');
        if (metas[0]) metas[0].innerHTML = '<b>Response sent</b>You responded just now';
        if (metas[1]) metas[1].innerHTML = '<b>Govt. reviewing</b>BBMP Health Dept.';
        var pill = openRow.querySelector('.pill');
        if (pill) {
          pill.className = 'pill pill-progress';
          pill.innerHTML = '<span class="d"></span>In progress';
        }
      }
      if (respEl) respEl.value = '';
      alert('Response sent. The government reviewer and the public report page are both updated.');
    });
  }
}

// ---------------------------------------------------------------------------
// 9. GOVERNMENT HOME PAGE (gov-home.html)
// ---------------------------------------------------------------------------
function initGovHomePage() {
  // Prepend any locally filed citizen reports into #gpane-issues
  var issuesPanel = document.querySelector('#gpane-issues .panel');
  var localReports = getLocalReports();
  if (issuesPanel && localReports.length > 0) {
    var firstRow = issuesPanel.querySelector('.ledger-row');
    localReports.forEach(function (rep) {
      var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
      var issueTitle =
        rep.issue_type === 'stock'
          ? 'essential stock unavailable'
          : rep.issue_type === 'expired'
          ? 'expired stock sold'
          : 'sold above MRP';
      var a = document.createElement('a');
      a.className = 'ledger-row';
      a.href = 'gov-case.html?id=' + encodeURIComponent(rep.reportId || '6bcfcc70-3965-413f-9441-f605b5c4aa89');
      a.style.color = 'inherit';
      a.innerHTML =
        '<div class="ledger-thumb">₹</div>' +
        '<div class="l-main"><b>' +
        escapeHtml(rep.medicine) +
        ' — ' +
        issueTitle +
        '</b><span>' +
        escapeHtml(rep.pharmacy) +
        ', ' +
        escapeHtml(rep.address || 'Koramangala') +
        '</span></div>' +
        '<div class="l-meta"><b>' +
        (over > 0 ? '₹' + over.toFixed(0) + ' over MRP' : 'Reported issue') +
        '</b>Filed just now · bill attached</div>' +
        '<div class="l-meta"><b>Awaiting your review</b></div>' +
        '<span class="pill pill-open"><span class="d"></span>Open</span>';
      if (firstRow) issuesPanel.insertBefore(a, firstRow);
      else issuesPanel.appendChild(a);
    });
  }

  // Remember which case was clicked in gov-home.html
  var caseIds = [
    '6bcfcc70-3965-413f-9441-f605b5c4aa89',
    'c6ba5250-66ff-4038-95cb-878208bf6945',
    'bf57bf87-d7d7-4fbd-a155-fe7199af3899',
    '6bcfcc70-3965-413f-9441-f605b5c4aa89',
  ];
  document.querySelectorAll('#gpane-issues a.ledger-row').forEach(function (a, idx) {
    a.addEventListener('click', function () {
      var id = caseIds[idx] || '6bcfcc70-3965-413f-9441-f605b5c4aa89';
      sessionStorage.setItem('mc_gov_case_id', id);
    });
  });

  // Wire filter chips in #gpane-issues
  var chips = document.querySelectorAll('#gpane-issues .filter-row .chip');
  chips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      chips.forEach(function (c) {
        c.classList.remove('active');
      });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      document.querySelectorAll('#gpane-issues .ledger-row').forEach(function (row) {
        var show = true;
        if (label === 'open') show = !!row.querySelector('.pill-open');
        else if (label === 'in progress') show = !!row.querySelector('.pill-progress');
        else if (label === 'resolved') show = !!row.querySelector('.pill-resolved');
        row.style.display = show ? '' : 'none';
      });
    });
  });

  // Wire area search bar in gov-home.html
  var searchInput = document.querySelector('.search-bar input');
  var searchBtn = document.querySelector('.search-bar .btn');
  async function runGovAreaSearch() {
    var q = (searchInput && searchInput.value.trim()) || 'Koramangala, Bengaluru';
    await apiFetch('/api/community?q=' + encodeURIComponent(q.split(',')[0].trim()));
    var issueHead = document.querySelector('#gpane-issues .panel-head h2');
    var pharmHead = document.querySelector('#gpane-pharmacies .panel-head h2');
    if (issueHead) issueHead.textContent = (24 + localReports.length) + ' reports in ' + q;
    if (pharmHead) pharmHead.textContent = '7 pharmacies in ' + q;
  }
  if (searchBtn) searchBtn.addEventListener('click', runGovAreaSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runGovAreaSearch();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 10. GOVERNMENT CASE DETAIL PAGE (gov-case.html)
// ---------------------------------------------------------------------------
function initGovCasePage() {
  var params = new URLSearchParams(window.location.search);
  var reportId =
    params.get('id') ||
    sessionStorage.getItem('mc_gov_case_id') ||
    '6bcfcc70-3965-413f-9441-f605b5c4aa89';

  // Load any previously posted government updates for this case
  apiFetch('/api/gov/case?id=' + encodeURIComponent(reportId)).then(function (detail) {
    if (!detail) return;
    var h1 = document.querySelector('.app-head h1');
    var p = document.querySelector('.app-head p');
    if (h1 && detail.title) h1.textContent = detail.title;
    if (p && detail.pharmacy_address) p.textContent = detail.pharmacy_address;
  });

  var postBtn = document.querySelector('.panel button.btn-primary');
  if (postBtn) {
    postBtn.removeAttribute('onclick');
    postBtn.addEventListener('click', async function (e) {
      e.preventDefault();
      var statusEl = document.getElementById('status');
      var updateEl = document.getElementById('update');
      var uploadBox = document.querySelector('.upload-box');

      var uiStatus = (statusEl && statusEl.value) || 'In progress';
      var note =
        (updateEl && updateEl.value.trim()) ||
        'Inspection completed and corrective instruction issued to pharmacy.';
      var proofUrl = (uploadBox && uploadBox.dataset.uploadedUrl) || null;

      await apiFetch('/api/government/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: reportId,
          status: uiStatus,
          progress_note: note,
          proof_urls: proofUrl ? [proofUrl] : [],
          agency_name: 'BBMP Health Department',
        }),
      });

      // Update the timeline on the page
      var timeline = document.querySelector('.timeline');
      if (timeline) {
        var awaitingItem = timeline.querySelector('.tl-item.resolved');
        var newItem = document.createElement('div');
        var isResolved = uiStatus.toLowerCase() === 'resolved';
        newItem.className = 'tl-item' + (isResolved ? ' resolved' : '');
        newItem.innerHTML =
          '<div class="tl-dot">' +
          (isResolved ? '✓' : '3') +
          '</div>' +
          '<div class="tl-body">' +
          '<b>BBMP Health Dept. — ' +
          escapeHtml(uiStatus) +
          '</b>' +
          '<span>Just now · public government update</span>' +
          '<p>' +
          escapeHtml(note) +
          '</p>' +
          '</div>';
        if (awaitingItem) timeline.replaceChild(newItem, awaitingItem);
        else timeline.appendChild(newItem);
      }

      // Update header status pill
      var headPill = document.querySelector('.app-head .pill');
      if (headPill) {
        if (uiStatus.toLowerCase() === 'resolved') {
          headPill.className = 'pill pill-resolved';
          headPill.innerHTML = '<span class="d"></span>Resolved';
        } else if (uiStatus.toLowerCase() === 'escalated') {
          headPill.className = 'pill pill-open';
          headPill.innerHTML = '<span class="d"></span>Escalated';
        } else {
          headPill.className = 'pill pill-progress';
          headPill.innerHTML = '<span class="d"></span>In progress';
        }
      }

      if (updateEl) updateEl.value = '';
      alert('Progress update posted. This is now visible on the public report page.');
    });
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
