// MediCheck — shared interactions + live clean-start demo state + Google-Maps-style location finding (No Map)
document.addEventListener('DOMContentLoaded', function () {
  // Clear legacy sessionStorage keys so old demo rows never reappear
  try {
    sessionStorage.removeItem('mc_local_reports');
  } catch (_e) {}

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

  // 2. Inject "Reset demo" button in .app-user bar so user can reset state anytime
  initResetDemoButton();

  // 3. Interactive Upload Boxes (.upload-box) across scan, report, pharmacy, gov pages
  initUploadBoxes();

  // 4. Page-specific integrations
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

// ---------------------------------------------------------------------------
// BUILT-IN 12 ACTUAL MEDICINES CATALOG (Instant Barcode & Name Lookup)
// ---------------------------------------------------------------------------
var ACTUAL_MEDICINES_CATALOG = [
  { barcode: '8901234560013', medicine: 'Dolo 650, 15 tablets', brand_name: 'Dolo 650', mrp: 32.28, manufacturer: 'Micro Labs Ltd.', salt: 'paracetamol 650 mg' },
  { barcode: '8901234560020', medicine: 'Pan 40, 15 tablets', brand_name: 'Pan 40', mrp: 192.80, manufacturer: 'Alkem Laboratories Ltd.', salt: 'pantoprazole 40 mg' },
  { barcode: '8901234560037', medicine: 'Telma 40, 15 tablets', brand_name: 'Telma 40', mrp: 108.36, manufacturer: 'Glenmark Pharmaceuticals Ltd.', salt: 'telmisartan 40 mg' },
  { barcode: '8901234560044', medicine: 'Glycomet 500, 20 tablets', brand_name: 'Glycomet 500', mrp: 19.59, manufacturer: 'USV Pvt. Ltd.', salt: 'metformin 500 mg' },
  { barcode: '8901234560051', medicine: 'Azithral 500, 5 tablets', brand_name: 'Azithral 500', mrp: 131.27, manufacturer: 'Alembic Pharmaceuticals Ltd.', salt: 'azithromycin 500 mg' },
  { barcode: '8901234560068', medicine: 'Amlong 5, 15 tablets', brand_name: 'Amlong 5', mrp: 48.55, manufacturer: 'Micro Labs Ltd.', salt: 'amlodipine 5 mg' },
  { barcode: '8901234560075', medicine: 'Allegra 120, 10 tablets', brand_name: 'Allegra 120', mrp: 272.99, manufacturer: 'Sanofi India Ltd.', salt: 'fexofenadine 120 mg' },
  { barcode: '8901234560082', medicine: 'Atorva 10, 15 tablets', brand_name: 'Atorva 10', mrp: 80.14, manufacturer: 'Zydus Healthcare Ltd.', salt: 'atorvastatin 10 mg' },
  { barcode: '8901234560099', medicine: 'Thyronorm 100, 100 tablets', brand_name: 'Thyronorm 100', mrp: 177.36, manufacturer: 'Abbott India Ltd.', salt: 'levothyroxine 100 mcg' },
  { barcode: '8901234560105', medicine: 'Augmentin 625 Duo, 10 tablets', brand_name: 'Augmentin 625 Duo', mrp: 201.71, manufacturer: 'GlaxoSmithKline Pharmaceuticals Ltd.', salt: 'amoxicillin + clavulanic acid 625 mg' },
  { barcode: '8901234560112', medicine: 'Crocin Advance 500, 20 tablets', brand_name: 'Crocin Advance 500', mrp: 20.00, manufacturer: 'Haleon India Pvt. Ltd.', salt: 'paracetamol 500 mg' },
  { barcode: '8901234560129', medicine: 'Ecosprin 75, 14 tablets', brand_name: 'Ecosprin 75', mrp: 5.49, manufacturer: 'USV Pvt. Ltd.', salt: 'aspirin 75 mg' }
];

function findLocalCatalogMedicine(query) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  var digits = q.replace(/[^0-9]/g, '');
  for (var i = 0; i < ACTUAL_MEDICINES_CATALOG.length; i++) {
    var m = ACTUAL_MEDICINES_CATALOG[i];
    if (m.barcode === q || (digits.length >= 12 && digits.indexOf(m.barcode) !== -1) || ('0' + m.barcode) === digits) {
      return m;
    }
    if (m.brand_name.toLowerCase() === q || m.medicine.toLowerCase().indexOf(q) !== -1) {
      return m;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// UNIFIED CLEAN-START LIVE DEMO STATE (Shared across Citizen, Pharmacy & Gov)
// ---------------------------------------------------------------------------
var DEMO_STATE_KEY = 'mc_demo_state_v2';

function createFreshDemoState() {
  return {
    reports: [],
    pharmacy: {
      name: 'Sundar Medicals',
      address: '12, 5th Block, Koramangala, Bengaluru 560095',
      area: 'Koramangala, Bengaluru',
      verified: false,
      verified_at: null,
      items_scanned: 0,
      period: null,
      submissions: []
    }
  };
}

function getDemoState() {
  try {
    var raw = localStorage.getItem(DEMO_STATE_KEY);
    if (!raw) return createFreshDemoState();
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createFreshDemoState();
    if (!Array.isArray(parsed.reports)) parsed.reports = [];
    if (!parsed.pharmacy || typeof parsed.pharmacy !== 'object') {
      parsed.pharmacy = createFreshDemoState().pharmacy;
    }
    if (!Array.isArray(parsed.pharmacy.submissions)) parsed.pharmacy.submissions = [];
    return parsed;
  } catch (_e) {
    return createFreshDemoState();
  }
}

function saveDemoState(state) {
  try {
    localStorage.setItem(DEMO_STATE_KEY, JSON.stringify(state));
  } catch (_e) {}
}

function initResetDemoButton() {
  var userBox = document.querySelector('.app-user');
  if (!userBox || document.getElementById('mc-reset-demo-btn')) return;
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'mc-reset-demo-btn';
  btn.className = 'btn btn-ghost btn-sm';
  btn.style.fontSize = '.78rem';
  btn.textContent = 'Reset demo';
  btn.title = 'Clear all filed reports and reset pharmacy verification status to start fresh';
  btn.addEventListener('click', async function () {
    localStorage.removeItem(DEMO_STATE_KEY);
    sessionStorage.removeItem('mc_scan');
    sessionStorage.removeItem('mc_gov_case_id');
    sessionStorage.removeItem('mc_local_reports');
    await apiFetch('/api/demo/reset', { method: 'POST' });
    window.location.reload();
  });
  userBox.insertBefore(btn, userBox.firstChild);
}

// ---------------------------------------------------------------------------
// GOOGLE-MAPS-STYLE LOCATION AUTOCOMPLETE + GPS "LOCATE ME"
// ---------------------------------------------------------------------------
var BUILTIN_INDIAN_PLACES = [
  { primary: 'Koramangala 5th Block', secondary: 'Koramangala, Bengaluru, Karnataka 560095', full: 'Koramangala, Bengaluru 560095' },
  { primary: 'Koramangala 80 Feet Road', secondary: 'Koramangala 4th Block, Bengaluru, Karnataka 560034', full: '80 Feet Road, Koramangala, Bengaluru 560034' },
  { primary: 'Indiranagar 100 Feet Road', secondary: 'HAL 2nd Stage, Indiranagar, Bengaluru, Karnataka 560038', full: 'Indiranagar, Bengaluru 560038' },
  { primary: 'HSR Layout Sector 2', secondary: 'HSR Layout, Bengaluru, Karnataka 560102', full: 'HSR Layout, Bengaluru 560102' },
  { primary: 'Jayanagar 4th Block', secondary: 'Jayanagar, Bengaluru, Karnataka 560011', full: 'Jayanagar, Bengaluru 560011' },
  { primary: 'Whitefield Main Road', secondary: 'Whitefield, Bengaluru, Karnataka 560066', full: 'Whitefield, Bengaluru 560066' },
  { primary: 'MG Road', secondary: 'Shanthala Nagar, Ashok Nagar, Bengaluru, Karnataka 560001', full: 'MG Road, Bengaluru 560001' },
  { primary: 'Andheri West', secondary: 'Mumbai Suburban, Mumbai, Maharashtra 400058', full: 'Andheri West, Mumbai 400058' },
  { primary: 'Bandra West', secondary: 'Linking Road, Mumbai, Maharashtra 400050', full: 'Bandra West, Mumbai 400050' },
  { primary: 'Dadar East', secondary: 'Station Road, Mumbai, Maharashtra 400014', full: 'Dadar East, Mumbai 400014' },
  { primary: 'Powai Hiranandani Gardens', secondary: 'Powai, Mumbai, Maharashtra 400076', full: 'Powai, Mumbai 400076' },
  { primary: 'Connaught Place', secondary: 'New Delhi, Delhi 110001', full: 'Connaught Place, New Delhi 110001' },
  { primary: 'Lajpat Nagar Central Market', secondary: 'South Delhi, New Delhi, Delhi 110024', full: 'Lajpat Nagar, New Delhi 110024' },
  { primary: 'Anna Nagar', secondary: 'Chennai, Tamil Nadu 600040', full: 'Anna Nagar, Chennai 600040' },
  { primary: 'T. Nagar', secondary: 'Thyagaraya Nagar, Chennai, Tamil Nadu 600017', full: 'T. Nagar, Chennai 600017' },
  { primary: 'Banjara Hills', secondary: 'Road No. 12, Hyderabad, Telangana 500034', full: 'Banjara Hills, Hyderabad 500034' },
  { primary: 'Gachibowli', secondary: 'SERILINGAMPALLY, Hyderabad, Telangana 500032', full: 'Gachibowli, Hyderabad 500032' },
  { primary: 'Koregaon Park', secondary: 'Pune, Maharashtra 411001', full: 'Koregaon Park, Pune 411001' },
  { primary: 'Salt Lake Sector V', secondary: 'Bidhannagar, Kolkata, West Bengal 700091', full: 'Salt Lake, Kolkata 700091' }
];

function attachLocationAutocomplete(inputEl, locateBtnEl, onPlaceSelected) {
  if (!inputEl || inputEl.dataset.locWired === '1') return;
  inputEl.dataset.locWired = '1';

  var parent = inputEl.parentElement;
  if (parent) {
    var pos = window.getComputedStyle(parent).position;
    if (pos === 'static') parent.style.position = 'relative';
  }

  var dropdown = document.createElement('div');
  dropdown.className = 'mc-loc-dropdown';
  dropdown.style.cssText =
    'position:absolute;left:0;right:0;top:calc(100% + 6px);background:#fff;border:1px solid var(--line,#e4e6eb);' +
    'border-radius:14px;box-shadow:0 14px 36px rgba(15,23,42,.14);z-index:999;max-height:290px;overflow-y:auto;display:none;padding:6px;';
  if (parent) parent.appendChild(dropdown);

  var debounceTimer = null;

  function renderSuggestions(items, queryText) {
    dropdown.innerHTML = '';
    if (!items || items.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    var header = document.createElement('div');
    header.style.cssText =
      'padding:6px 10px 4px;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft,#64748b);display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = '<span>Location suggestions</span><span style="font-weight:500;">OpenStreetMap · Places</span>';
    dropdown.appendChild(header);

    items.forEach(function (item) {
      var row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:10px;cursor:pointer;transition:background .15s;';
      row.innerHTML =
        '<span style="color:var(--orange,#e86a24);margin-top:2px;flex-shrink:0;">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 22s7-7.58 7-13a7 7 0 1 0-14 0c0 5.42 7 13 7 13Z"/><circle cx="12" cy="9" r="2.5"/></svg>' +
        '</span>' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:.88rem;color:var(--ink,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
        escapeHtml(item.primary) +
        '</div>' +
        '<div style="font-size:.76rem;color:var(--ink-soft,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
        escapeHtml(item.secondary) +
        '</div>' +
        '</div>';

      row.addEventListener('mouseenter', function () {
        row.style.background = '#f8fafc';
      });
      row.addEventListener('mouseleave', function () {
        row.style.background = 'transparent';
      });
      row.addEventListener('mousedown', function (e) {
        e.preventDefault();
        inputEl.value = item.full;
        dropdown.style.display = 'none';
        if (typeof onPlaceSelected === 'function') onPlaceSelected(item.full, item);
      });
      dropdown.appendChild(row);
    });

    dropdown.style.display = 'block';
  }

  async function fetchPlaceSuggestions(q) {
    var cleanQ = String(q || '').trim();
    var lowerQ = cleanQ.toLowerCase();

    var localMatches = BUILTIN_INDIAN_PLACES.filter(function (p) {
      return !lowerQ || p.primary.toLowerCase().indexOf(lowerQ) !== -1 || p.secondary.toLowerCase().indexOf(lowerQ) !== -1;
    }).slice(0, 4);

    if (cleanQ.length < 2) {
      renderSuggestions(localMatches, cleanQ);
      return;
    }

    // Show instant local matches first
    if (localMatches.length > 0) {
      renderSuggestions(localMatches, cleanQ);
    }

    try {
      var url =
        'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=in&addressdetails=1&limit=5&q=' +
        encodeURIComponent(cleanQ);
      var res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        var data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          var remoteItems = data.map(function (d) {
            var parts = String(d.display_name || '').split(',').map(function (s) { return s.trim(); });
            var primary = d.name || parts[0] || cleanQ;
            var city = (d.address && (d.address.city || d.address.town || d.address.state_district)) || parts[1] || '';
            var pin = (d.address && d.address.postcode) ? ' ' + d.address.postcode : '';
            var full = city ? primary + ', ' + city + pin : parts.slice(0, 3).join(', ');
            return {
              primary: primary,
              secondary: parts.slice(1, 5).join(', ') || d.display_name,
              full: full
            };
          });
          // Merge remote + non-duplicate local matches
          var combined = remoteItems.slice();
          localMatches.forEach(function (lm) {
            if (!combined.some(function (r) { return r.primary.toLowerCase() === lm.primary.toLowerCase(); })) {
              combined.push(lm);
            }
          });
          renderSuggestions(combined.slice(0, 6), cleanQ);
          return;
        }
      }
    } catch (_err) {}

    renderSuggestions(
      localMatches.length > 0
        ? localMatches
        : [{ primary: cleanQ, secondary: 'Search area in India', full: cleanQ }],
      cleanQ
    );
  }

  inputEl.addEventListener('focus', function () {
    fetchPlaceSuggestions(inputEl.value);
  });

  inputEl.addEventListener('input', function () {
    if (debounceTimer) clearTimeout(debounceTimer);
    var val = inputEl.value;
    debounceTimer = setTimeout(function () {
      fetchPlaceSuggestions(val);
    }, 220);
  });

  inputEl.addEventListener('blur', function () {
    setTimeout(function () {
      dropdown.style.display = 'none';
    }, 180);
  });

  if (locateBtnEl) {
    locateBtnEl.addEventListener('click', function () {
      var origText = locateBtnEl.textContent;
      if (!navigator.geolocation) {
        inputEl.value = 'Koramangala, Bengaluru 560095';
        if (typeof onPlaceSelected === 'function') onPlaceSelected(inputEl.value);
        return;
      }
      locateBtnEl.textContent = 'Locating...';
      navigator.geolocation.getCurrentPosition(
        async function (pos) {
          var lat = pos.coords.latitude;
          var lon = pos.coords.longitude;
          try {
            var revUrl =
              'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' +
              encodeURIComponent(lat) +
              '&lon=' +
              encodeURIComponent(lon);
            var r = await fetch(revUrl, { headers: { Accept: 'application/json' } });
            if (r.ok) {
              var d = await r.json();
              var addr = d.address || {};
              var suburb = addr.suburb || addr.neighbourhood || addr.residential || addr.road || d.name || '';
              var city = addr.city || addr.town || addr.state_district || addr.state || '';
              var pin = addr.postcode ? ' ' + addr.postcode : '';
              var formatted = [suburb, city].filter(Boolean).join(', ') + pin;
              if (formatted.trim()) {
                inputEl.value = formatted.trim();
                locateBtnEl.textContent = origText;
                if (typeof onPlaceSelected === 'function') onPlaceSelected(inputEl.value);
                return;
              }
            }
          } catch (_e) {}
          inputEl.value = 'Koramangala, Bengaluru 560095';
          locateBtnEl.textContent = origText;
          if (typeof onPlaceSelected === 'function') onPlaceSelected(inputEl.value);
        },
        function () {
          inputEl.value = 'Koramangala, Bengaluru 560095';
          locateBtnEl.textContent = origText;
          if (typeof onPlaceSelected === 'function') onPlaceSelected(inputEl.value);
        },
        { enableHighAccuracy: true, timeout: 7000 }
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Interactive file picker + backend upload for .upload-box elements
// ---------------------------------------------------------------------------
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

// Helper to build status pill HTML
function renderStatusPill(status) {
  var st = String(status || 'open').toLowerCase();
  if (st === 'resolved') {
    return '<span class="pill pill-resolved"><span class="d"></span>Resolved</span>';
  }
  if (st === 'in_progress' || st === 'in progress') {
    return '<span class="pill pill-progress"><span class="d"></span>In progress</span>';
  }
  if (st === 'escalated') {
    return '<span class="pill pill-open"><span class="d"></span>Escalated</span>';
  }
  return '<span class="pill pill-open"><span class="d"></span>Open</span>';
}

function getIssueTitle(issueType) {
  if (issueType === 'stock') return 'essential stock unavailable';
  if (issueType === 'expired') return 'expired stock sold';
  return 'sold above MRP';
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

  var state = getDemoState();
  var reports = state.reports || [];
  var listEl = document.getElementById('home-reports-list') || document.querySelector('.two-col .panel');

  if (listEl) {
    // Remove any existing rows or empty placeholders inside listEl
    if (listEl.id === 'home-reports-list') {
      listEl.innerHTML = '';
    } else {
      listEl.querySelectorAll('.ledger-row').forEach(function (r) { r.remove(); });
    }

    if (reports.length === 0) {
      var emptyDiv = document.createElement('div');
      emptyDiv.id = 'home-reports-empty';
      emptyDiv.style.cssText = 'padding:28px 8px;text-align:center;color:var(--ink-soft);font-size:.9rem;';
      emptyDiv.textContent = 'No reports filed yet. Scan a medicine barcode or file a report to see it here.';
      listEl.appendChild(emptyDiv);
    } else {
      reports.forEach(function (rep) {
        var row = document.createElement('div');
        row.className = 'ledger-row';
        var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
        var issueTitle = getIssueTitle(rep.issue_type);
        var meta1 =
          rep.issue_type === 'overpriced' && over > 0
            ? '<b>₹' + over.toFixed(2) + ' over MRP</b>Billed ₹' + Number(rep.billed).toFixed(2) + ' vs ₹' + Number(rep.mrp).toFixed(2)
            : rep.issue_type === 'stock'
            ? '<b>Stock unavailable</b>Reported just now'
            : '<b>Batch reported</b>Bill attached';

        var govCol = '<b>Just now</b>Bill attached';
        if (rep.gov_updates && rep.gov_updates.length > 0) {
          var lastGov = rep.gov_updates[rep.gov_updates.length - 1];
          govCol = '<b>' + escapeHtml(lastGov.status) + '</b>' + escapeHtml(lastGov.agency || 'BBMP Health Dept.');
        } else if (rep.pharmacy_response) {
          govCol = '<b>Pharmacy replied</b>BBMP Health Dept.';
        }

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
          '<div class="l-meta">' +
          govCol +
          '</div>' +
          renderStatusPill(rep.status);

        listEl.appendChild(row);
      });
    }
  }

  // Update Citizen stat cards
  var openCnt = reports.filter(function (r) { return !r.status || r.status === 'open' || r.status === 'escalated'; }).length;
  var progCnt = reports.filter(function (r) { return r.status === 'in_progress' || r.status === 'in progress'; }).length;
  var resCnt = reports.filter(function (r) { return r.status === 'resolved'; }).length;

  var totalEl = document.getElementById('home-stat-total');
  var openEl = document.getElementById('home-stat-open');
  var progEl = document.getElementById('home-stat-progress');
  var resEl = document.getElementById('home-stat-resolved');
  var verPharmEl = document.getElementById('home-verified-pharm-count');

  if (totalEl) totalEl.textContent = String(reports.length);
  if (openEl) openEl.textContent = String(openCnt);
  if (progEl) progEl.textContent = String(progCnt);
  if (resEl) resEl.textContent = String(resCnt);
  if (verPharmEl) verPharmEl.textContent = state.pharmacy && state.pharmacy.verified ? '1' : '0';
}

// ---------------------------------------------------------------------------
// 3. CITIZEN BARCODE SCANNER PAGE (scan.html)
// ---------------------------------------------------------------------------
function initScanPage() {
  var currentScannedProduct = {
    barcode: '8901234560013',
    medicine: 'Dolo 650, 15 tablets',
    mrp: 32.28,
    manufacturer: 'Micro Labs Ltd.',
    salt: 'paracetamol 650 mg',
  };

  var html5QrScanner = null;

  var scanStage = document.querySelector('#scan-step-1 .scan-stage');
  var viewfinder = document.querySelector('#scan-step-1 .viewfinder');
  var simBtn = document.querySelector('#scan-step-1 .scan-stage button.btn-primary');

  if (scanStage && viewfinder) {
    viewfinder.id = 'mc-camera-reader';
    viewfinder.style.overflow = 'hidden';

    var controlsWrap = document.createElement('div');
    controlsWrap.style.cssText = 'width:100%;max-width:340px;margin-top:14px;display:flex;flex-direction:column;gap:8px;';
    controlsWrap.innerHTML =
      '<div style="display:flex;gap:8px;">' +
      '<input type="text" id="barcode-manual-input" placeholder="Scan or enter barcode (e.g. 8901234560013)" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;font-size:.85rem;" value="8901234560013">' +
      '<button type="button" id="barcode-lookup-btn" class="btn btn-primary btn-sm" style="padding:10px 14px;">Lookup</button>' +
      '</div>' +
      '<button type="button" id="start-camera-btn" class="btn btn-outline btn-sm" style="color:#fff;border-color:rgba(255,255,255,.35);width:100%;">Open phone camera scanner</button>';

    if (simBtn) {
      scanStage.insertBefore(controlsWrap, simBtn);
      simBtn.style.marginTop = '8px';
    } else {
      scanStage.appendChild(controlsWrap);
    }

    var lookupBtn = document.getElementById('barcode-lookup-btn');
    var manualInput = document.getElementById('barcode-manual-input');
    var camBtn = document.getElementById('start-camera-btn');

    if (lookupBtn && manualInput) {
      lookupBtn.addEventListener('click', function () {
        var code = manualInput.value.trim() || '8901234560013';
        resolveBarcodeAndOpenStep2(code);
      });
      manualInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var code = manualInput.value.trim() || '8901234560013';
          resolveBarcodeAndOpenStep2(code);
        }
      });
    }

    if (camBtn) {
      camBtn.addEventListener('click', function () {
        startPhoneCameraScanner(camBtn);
      });
    }
  }

  function startPhoneCameraScanner(btnEl) {
    function launchScanner() {
      if (typeof Html5Qrcode === 'undefined') return;
      btnEl.textContent = 'Starting camera...';
      try {
        html5QrScanner = new Html5Qrcode('mc-camera-reader');
        html5QrScanner
          .start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 220, height: 140 } },
            function (decodedText) {
              var cleanCode = String(decodedText || '').trim();
              if (!cleanCode) return;
              var manualInput = document.getElementById('barcode-manual-input');
              if (manualInput) manualInput.value = cleanCode;
              stopPhoneCameraScanner();
              resolveBarcodeAndOpenStep2(cleanCode);
            },
            function () {}
          )
          .then(function () {
            btnEl.textContent = 'Camera active — point at barcode';
          })
          .catch(function (_err) {
            btnEl.textContent = 'Camera unavailable — use barcode input above';
          });
      } catch (_e) {
        btnEl.textContent = 'Camera unavailable — use barcode input above';
      }
    }

    if (typeof Html5Qrcode !== 'undefined') {
      launchScanner();
      return;
    }
    btnEl.textContent = 'Loading scanner...';
    var script = document.createElement('script');
    script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    script.onload = launchScanner;
    script.onerror = function () {
      btnEl.textContent = 'Offline — type barcode above';
    };
    document.head.appendChild(script);
  }

  function stopPhoneCameraScanner() {
    if (html5QrScanner) {
      try {
        html5QrScanner.stop().catch(function () {});
      } catch (_e) {}
      html5QrScanner = null;
    }
  }

  async function resolveBarcodeAndOpenStep2(code) {
    var cleanCode = String(code || '8901234560013').trim();
    var localHit = findLocalCatalogMedicine(cleanCode);
    if (localHit) {
      currentScannedProduct = {
        barcode: localHit.barcode,
        medicine: localHit.medicine,
        mrp: Number(localHit.mrp),
        manufacturer: localHit.manufacturer,
        salt: localHit.salt,
      };
    }

    var data = await apiFetch('/api/check?q=' + encodeURIComponent(cleanCode));
    if (data && data.check && data.check.product) {
      var p = data.check.product;
      currentScannedProduct = {
        barcode: cleanCode,
        medicine: p.brand_name + ', ' + p.pack_size + ' ' + p.pack_unit,
        mrp: Number(p.printed_mrp),
        manufacturer: p.manufacturer,
        salt: p.salt_normalized + ' ' + p.strength,
      };
      window.__lastBackendCheck = data.check;
    } else if (data && data.candidates && data.candidates[0]) {
      var c = data.candidates[0];
      currentScannedProduct = {
        barcode: cleanCode,
        medicine: c.brand_name + ', ' + c.pack_size + ' ' + c.pack_unit,
        mrp: Number(c.printed_mrp),
        manufacturer: c.manufacturer,
        salt: c.salt_normalized + ' ' + c.strength,
      };
    }

    var step2Panel = document.querySelector('#scan-step-2 .panel');
    if (step2Panel) {
      var pillEl = step2Panel.querySelector('.pill');
      if (pillEl) {
        pillEl.innerHTML = '<span class="d"></span>Barcode ' + escapeHtml(currentScannedProduct.barcode) + ' recognised';
      }
      var h3 = step2Panel.querySelector('h3');
      if (h3) h3.textContent = currentScannedProduct.medicine;
      var mrpP = step2Panel.querySelector('p');
      if (mrpP) {
        mrpP.innerHTML =
          'Registered MRP: <b style="color:var(--ink);">₹' +
          currentScannedProduct.mrp.toFixed(2) +
          '</b> · <span style="color:var(--ink-soft);">' +
          escapeHtml(currentScannedProduct.manufacturer) +
          '</span>';
      }
      var billedInput = document.getElementById('billed');
      if (billedInput) {
        billedInput.value = '';
        billedInput.placeholder =
          '₹ (<= ' +
          currentScannedProduct.mrp.toFixed(2) +
          ' is fair; > ' +
          currentScannedProduct.mrp.toFixed(2) +
          ' is overpriced)';
      }
    }

    origGoStep(2);
  }

  var origGoStep = window.goStep;
  window.goStep = function (n) {
    if (n === 2) {
      var manualInput = document.getElementById('barcode-manual-input');
      var code = (manualInput && manualInput.value.trim()) || '8901234560013';
      resolveBarcodeAndOpenStep2(code);
      return;
    }
    if (n === 1) {
      stopPhoneCameraScanner();
    }
    if (typeof origGoStep === 'function') origGoStep(n);
  };

  window.checkPrice = function () {
    var billedRaw = document.getElementById('billed').value.replace(/[^0-9.]/g, '');
    var billedNum = billedRaw ? Number(billedRaw) : Number((currentScannedProduct.mrp + 18).toFixed(2));
    var mrpNum = Number(currentScannedProduct.mrp);
    var pharm = document.getElementById('pharm').value || 'Sundar Medicals';
    var uploadBox = document.querySelector('#scan-step-2 .upload-box');
    var uploadedUrl = uploadBox ? uploadBox.dataset.uploadedUrl : null;

    var diff = Number((billedNum - mrpNum).toFixed(2));
    var isOverpriced = diff > 0.009;

    sessionStorage.setItem(
      'mc_scan',
      JSON.stringify({
        barcode: currentScannedProduct.barcode,
        medicine: currentScannedProduct.medicine,
        mrp: mrpNum,
        billed: billedNum,
        overcharge: isOverpriced ? diff : 0,
        is_fair: !isOverpriced,
        pharmacy: pharm,
        bill_photo_url: uploadedUrl || null,
      })
    );

    var step3Panel = document.querySelector('#scan-step-3 .panel');
    if (step3Panel) {
      if (!isOverpriced) {
        var saved = Math.max(0, Number((mrpNum - billedNum).toFixed(2)));
        step3Panel.innerHTML =
          '<div style="width:56px;height:56px;border-radius:50%;background:#e9f3ec;color:var(--ok);display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:1.5rem;font-weight:800;">✓</div>' +
          '<h3 style="font-size:1.2rem;margin-top:10px;color:var(--ok);">Billed fairly — within MRP</h3>' +
          '<p style="margin-top:8px;">You were billed <b style="color:var(--ok);">₹' +
          billedNum.toFixed(2) +
          '</b> for <b>' +
          escapeHtml(currentScannedProduct.medicine) +
          '</b> with a registered MRP of <b style="color:var(--ink);">₹' +
          mrpNum.toFixed(2) +
          '</b>' +
          (saved > 0 ? ' (₹' + saved.toFixed(2) + ' below MRP).' : ' (exact MRP).') +
          '</p>' +
          '<button type="button" class="btn btn-ink btn-block" style="margin-top:22px;" onclick="goStep(1)">Scan another medicine</button>' +
          '<a href="report.html?from=scan" class="btn btn-outline btn-block" style="margin-top:8px;">Report another issue (stock / expiry)</a>' +
          '<a href="home.html" class="btn btn-ghost btn-block" style="margin-top:6px;">Back to home</a>';
      } else {
        step3Panel.innerHTML =
          '<div style="width:56px;height:56px;border-radius:50%;background:#fdece0;color:var(--orange-deep);display:flex;align-items:center;justify-content:center;margin:0 auto;">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="26" height="26"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>' +
          '</div>' +
          '<h3 style="font-size:1.2rem;margin-top:10px;">Price mismatch found</h3>' +
          '<p style="margin-top:8px;">You were billed <b style="color:var(--orange-deep);">₹' +
          billedNum.toFixed(2) +
          '</b> for <b>' +
          escapeHtml(currentScannedProduct.medicine) +
          '</b> with a registered MRP of <b style="color:var(--ink);">₹' +
          mrpNum.toFixed(2) +
          '</b> — <b style="color:var(--orange-deep);">₹' +
          diff.toFixed(2) +
          ' over MRP</b>.</p>' +
          '<a href="report.html?from=scan" class="btn btn-primary btn-block" style="margin-top:22px;">Continue to report</a>' +
          '<button type="button" class="btn btn-outline btn-block" style="margin-top:8px;" onclick="goStep(1)">Scan another medicine</button>' +
          '<a href="home.html" class="btn btn-ghost btn-block" style="margin-top:6px;">Not now</a>';
      }
    }

    if (typeof origGoStep === 'function') origGoStep(3);
  };
}

// ---------------------------------------------------------------------------
// 4. CITIZEN ADD REPORT PAGE (report.html)
// ---------------------------------------------------------------------------
function initReportPage() {
  var addrInput = document.getElementById('address');
  var locateBtn = document.getElementById('report-locate-btn');
  attachLocationAutocomplete(addrInput, locateBtn, null);

  window.submitReport = async function () {
    var issueEl = document.getElementById('issue-type');
    var medEl = document.getElementById('medicine');
    var mrpEl = document.getElementById('mrp');
    var billedEl = document.getElementById('billed');
    var pharmEl = document.getElementById('pharmacy');
    var addrEl = document.getElementById('address');
    var notesEl = document.getElementById('notes');
    var uploadBox = document.querySelector('.upload-box');

    var mrpVal = Number(String((mrpEl && mrpEl.value) || '32.28').replace(/[^0-9.]/g, '')) || 32.28;
    var billedVal = Number(String((billedEl && billedEl.value) || '50').replace(/[^0-9.]/g, '')) || mrpVal;

    var payload = {
      issue_type: issueEl ? issueEl.value : 'overpriced',
      medicine: (medEl && medEl.value.trim()) || 'Dolo 650, 15 tablets',
      mrp: mrpVal,
      billed: billedVal,
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

    var reportId = (res && res.reportId) || 'rep-' + Date.now();
    var state = getDemoState();
    state.reports.unshift({
      id: reportId,
      issue_type: payload.issue_type,
      medicine: payload.medicine,
      mrp: payload.mrp,
      billed: payload.billed,
      overcharge: Math.max(0, Number((payload.billed - payload.mrp).toFixed(2))),
      pharmacy: payload.pharmacy,
      address: payload.address,
      notes: payload.notes,
      bill_photo_url: payload.bill_photo_url,
      bill_photo_name: (uploadBox && uploadBox.dataset.uploadedFilename) || 'attached bill.jpg',
      filed_at: new Date().toISOString(),
      status: 'open',
      price_corrected: false,
      pharmacy_response: null,
      gov_updates: [],
    });
    saveDemoState(state);
    sessionStorage.removeItem('mc_scan');

    alert('Report submitted. It is now live on your Home & Area pages, the Pharmacy portal, and the Government portal.');
    window.location.href = 'home.html';
  };
}

// ---------------------------------------------------------------------------
// 5. CITIZEN AREA SEARCH PAGE (area.html — Google-Maps-Style Location Search, No Map)
// ---------------------------------------------------------------------------
function initAreaPage() {
  if (window.location.hash === '#pharmacies') {
    var pharmBtn = document.querySelectorAll('[data-tabgroup="area"] .tab-btn')[1];
    switchTab('area', 'pane-pharmacies', pharmBtn);
  }

  var searchInput = document.getElementById('area-search');
  var locateBtn = document.getElementById('area-locate-btn');
  var searchBtn = document.getElementById('area-search-btn') || document.querySelector('.search-bar .btn-primary');

  var activeIssueFilter = 'all';
  var activePharmFilter = 'verified';

  function renderAreaContent() {
    var state = getDemoState();
    var q = (searchInput && searchInput.value.trim()) || 'Koramangala, Bengaluru';
    var qPrimary = q.split(',')[0].trim().toLowerCase();

    var matchingReports = (state.reports || []).filter(function (r) {
      if (!qPrimary || qPrimary === 'koramangala') return true;
      var hay = ((r.address || '') + ' ' + (r.pharmacy || '') + ' ' + (r.medicine || '')).toLowerCase();
      return hay.indexOf(qPrimary) !== -1 || state.reports.length > 0;
    });

    var filteredReports = matchingReports.filter(function (r) {
      if (activeIssueFilter === 'overpriced') return r.issue_type === 'overpriced';
      if (activeIssueFilter === 'stock') return r.issue_type === 'stock';
      if (activeIssueFilter === 'expired') return r.issue_type === 'expired';
      if (activeIssueFilter === 'resolved') return r.status === 'resolved';
      return true;
    });

    var tabIssuesBtn = document.getElementById('area-tab-issues');
    var tabPharmBtn = document.getElementById('area-tab-pharmacies');
    var issueHead = document.getElementById('area-issues-heading') || document.querySelector('#pane-issues .panel-head h2');
    var pharmHead = document.getElementById('area-pharmacies-heading') || document.querySelector('#pane-pharmacies .panel-head h2');
    var issuesList = document.getElementById('area-issues-list');
    var pharmsList = document.getElementById('area-pharmacies-list');

    var isPharmVerified = Boolean(state.pharmacy && state.pharmacy.verified);
    var verifiedCount = isPharmVerified ? 1 : 0;

    if (tabIssuesBtn) tabIssuesBtn.textContent = 'Reported issues (' + matchingReports.length + ')';
    if (tabPharmBtn) tabPharmBtn.textContent = 'Verified pharmacies (' + verifiedCount + ')';
    if (issueHead) issueHead.textContent = filteredReports.length + ' issues in ' + q;
    if (pharmHead) pharmHead.textContent = verifiedCount + ' verified pharmacies in ' + q;

    if (issuesList) {
      issuesList.innerHTML = '';
      if (filteredReports.length === 0) {
        issuesList.innerHTML =
          '<div style="padding:28px 8px;text-align:center;color:var(--ink-soft);font-size:.9rem;">No reported issues in ' +
          escapeHtml(q) +
          ' yet.</div>';
      } else {
        filteredReports.forEach(function (rep) {
          var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
          var issueTitle = getIssueTitle(rep.issue_type);
          var govText = '<b>Awaiting review</b>BBMP Health Dept.';
          if (rep.gov_updates && rep.gov_updates.length > 0) {
            var lastGov = rep.gov_updates[rep.gov_updates.length - 1];
            govText = '<b>' + escapeHtml(lastGov.status) + '</b>' + escapeHtml(lastGov.agency || 'BBMP Health Dept.');
          } else if (rep.pharmacy_response) {
            govText = '<b>Pharmacy responded</b>BBMP Health Dept.';
          }

          var row = document.createElement('div');
          row.className = 'ledger-row';
          row.innerHTML =
            '<div class="ledger-thumb">₹</div>' +
            '<div class="l-main"><b>' +
            escapeHtml(rep.medicine) +
            ' — ' +
            issueTitle +
            '</b><span>' +
            escapeHtml(rep.pharmacy) +
            ', ' +
            escapeHtml(rep.address || q) +
            '</span></div>' +
            '<div class="l-meta"><b>' +
            (over > 0 ? '₹' + over.toFixed(2) + ' over MRP' : 'Reported issue') +
            '</b>Filed just now · bill attached</div>' +
            '<div class="l-meta">' +
            govText +
            '</div>' +
            renderStatusPill(rep.status);
          issuesList.appendChild(row);
        });
      }
    }

    if (pharmsList) {
      pharmsList.innerHTML = '';
      var showSundar = activePharmFilter === 'all' || isPharmVerified;
      if (!showSundar) {
        pharmsList.innerHTML =
          '<div style="padding:28px 8px;text-align:center;color:var(--ink-soft);font-size:.9rem;">No verified pharmacies in ' +
          escapeHtml(q) +
          ' yet. Pharmacies appear here once they submit stock & billing proof.</div>';
      } else {
        var openAgainst = (state.reports || []).filter(function (r) { return r.status !== 'resolved'; }).length;
        var pRow = document.createElement('div');
        pRow.className = 'pharm-row';
        pRow.innerHTML =
          '<div class="pharm-badge" style="' +
          (isPharmVerified ? '' : 'background:#f1f5f9;color:var(--ink-soft);') +
          '">' +
          (isPharmVerified ? '✓' : '—') +
          '</div>' +
          '<div class="p-main"><b>' +
          escapeHtml(state.pharmacy.name || 'Sundar Medicals') +
          '</b><span>' +
          escapeHtml(state.pharmacy.address || '12, 5th Block, Koramangala, Bengaluru 560095') +
          '</span></div>' +
          '<div class="p-meta">' +
          (isPharmVerified
            ? '<b>Stock & bills matched</b>Verified just now'
            : '<b>Not verified yet</b>Awaiting stock & billing proof') +
          '</div>' +
          '<div class="p-meta"><b>' +
          openAgainst +
          ' open reports</b>' +
          (state.reports.length + ' total') +
          '</div>' +
          (isPharmVerified
            ? '<span class="pill pill-verified"><span class="d"></span>Verified</span>'
            : '<span class="pill pill-none"><span class="d"></span>Not verified</span>');
        pharmsList.appendChild(pRow);
      }
    }
  }

  renderAreaContent();

  attachLocationAutocomplete(searchInput, locateBtn, function () {
    renderAreaContent();
  });

  if (searchBtn) {
    searchBtn.addEventListener('click', function () {
      renderAreaContent();
    });
  }
  if (searchInput) {
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        renderAreaContent();
      }
    });
  }

  // Wire filter chips in #pane-issues
  var issueChips = document.querySelectorAll('#pane-issues .filter-row .chip');
  issueChips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      issueChips.forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      if (label.indexOf('overpriced') !== -1) activeIssueFilter = 'overpriced';
      else if (label.indexOf('missing stock') !== -1) activeIssueFilter = 'stock';
      else if (label.indexOf('expired') !== -1) activeIssueFilter = 'expired';
      else if (label.indexOf('resolved') !== -1) activeIssueFilter = 'resolved';
      else activeIssueFilter = 'all';
      renderAreaContent();
    });
  });

  // Wire filter chips in #pane-pharmacies
  var pharmChips = document.querySelectorAll('#pane-pharmacies .filter-row .chip');
  pharmChips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      pharmChips.forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      activePharmFilter = label.indexOf('verified only') !== -1 ? 'verified' : 'all';
      renderAreaContent();
    });
  });
}

// ---------------------------------------------------------------------------
// 6. PHARMACY HOME PAGE (pharmacy-home.html)
// ---------------------------------------------------------------------------
function initPharmacyHomePage() {
  function renderPharmacyHome() {
    var state = getDemoState();
    var isVer = Boolean(state.pharmacy && state.pharmacy.verified);
    var reports = state.reports || [];
    var openReports = reports.filter(function (r) { return r.status !== 'resolved'; });

    var topPill = document.getElementById('pharmacy-verified-pill') || document.querySelector('.app-head .pill');
    var statusTitle = document.getElementById('pharmacy-verify-status-title');
    var statusSub = document.getElementById('pharmacy-verify-status-sub');
    var openCntEl = document.getElementById('pharmacy-open-reports-count');
    var matchRateEl = document.getElementById('pharmacy-match-rate');
    var matchSubEl = document.getElementById('pharmacy-match-sub');
    var priceListEl = document.getElementById('pharmacy-price-list');

    if (topPill) {
      if (isVer) {
        topPill.className = 'pill pill-verified';
        topPill.innerHTML = '<span class="d"></span>Verified pharmacy';
      } else {
        topPill.className = 'pill pill-none';
        topPill.innerHTML = '<span class="d"></span>Unverified pharmacy';
      }
    }

    if (statusTitle) {
      statusTitle.textContent = isVer ? 'Verified' : 'Not verified';
      statusTitle.style.color = isVer ? 'var(--ok)' : 'var(--ink-soft)';
    }
    if (statusSub) {
      statusSub.textContent = isVer
        ? 'Status — verified (' + (state.pharmacy.items_scanned || 1) + ' items & bills matched)'
        : 'Status — upload stock & billing proof to get verified';
    }
    if (openCntEl) {
      openCntEl.textContent = String(openReports.length);
      openCntEl.style.color = openReports.length > 0 ? 'var(--orange)' : 'var(--ink)';
    }

    var correctedCount = reports.filter(function (r) { return r.price_corrected; }).length;
    if (matchRateEl) {
      if (isVer) {
        matchRateEl.textContent = '100%';
      } else if (reports.length > 0) {
        matchRateEl.textContent = Math.round((correctedCount / reports.length) * 100) + '%';
      } else {
        matchRateEl.textContent = '—';
      }
    }
    if (matchSubEl) {
      matchSubEl.textContent = isVer
        ? 'All submitted bills match registered MRP'
        : reports.length > 0
        ? correctedCount + ' of ' + reports.length + ' reported items corrected'
        : 'Submit verification records to calculate match rate';
    }

    if (priceListEl) {
      priceListEl.innerHTML = '';
      if (reports.length === 0) {
        priceListEl.innerHTML =
          '<div style="padding:28px 8px;text-align:center;color:var(--ink-soft);font-size:.9rem;">No price mismatches or stock issues reported yet.</div>';
      } else {
        reports.forEach(function (rep) {
          var row = document.createElement('div');
          row.className = 'price-row';
          var isFixed = Boolean(rep.price_corrected);
          var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));

          row.innerHTML =
            '<div class="m-name"><b>' +
            escapeHtml(rep.medicine) +
            '</b><span>Reported at ' +
            escapeHtml(rep.pharmacy || 'Sundar Medicals') +
            '</span></div>' +
            '<div>' +
            (isFixed
              ? '<b>Your price: ₹' + Number(rep.mrp).toFixed(2) + '</b><div class="sub">Corrected to MRP</div>'
              : rep.issue_type === 'stock'
              ? '<b>Reported out of stock</b><div class="sub">1 citizen report</div>'
              : '<b>Your price: ₹' + Number(rep.billed).toFixed(2) + '</b><div class="sub">1 citizen report</div>') +
            '</div>' +
            '<div><b>Registered MRP: ₹' +
            Number(rep.mrp).toFixed(2) +
            '</b><div class="sub"' +
            (isFixed
              ? ' style="color:var(--ok);">Matches MRP</div>'
              : ' style="color:var(--orange-deep);">' +
                (over > 0 ? 'Over by ₹' + over.toFixed(2) : 'Needs attention') +
                '</div>') +
            '</div>' +
            (isFixed
              ? '<span class="pill pill-verified"><span class="d"></span>Matches</span>'
              : '<button type="button" class="btn btn-outline btn-sm" data-fix-id="' +
                escapeHtml(rep.id) +
                '">' +
                (rep.issue_type === 'stock' ? 'Update stock' : 'Mark corrected') +
                '</button>');

          priceListEl.appendChild(row);
        });

        priceListEl.querySelectorAll('button[data-fix-id]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var repId = btn.getAttribute('data-fix-id');
            var st = getDemoState();
            var target = (st.reports || []).find(function (r) { return r.id === repId; });
            if (target) {
              target.price_corrected = true;
              saveDemoState(st);
            }
            await apiFetch('/api/pharmacy/price-fix', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ item_id: 'price-item-1', action: 'mark_corrected' }),
            });
            renderPharmacyHome();
          });
        });
      }
    }
  }

  renderPharmacyHome();
}

// ---------------------------------------------------------------------------
// 7. PHARMACY VERIFY PAGE (pharmacy-verify.html)
// ---------------------------------------------------------------------------
function initPharmacyVerifyPage() {
  var state = getDemoState();
  var topPill = document.getElementById('pharmacy-verify-pill') || document.querySelector('.app-head .pill');
  if (topPill) {
    if (state.pharmacy && state.pharmacy.verified) {
      topPill.className = 'pill pill-verified';
      topPill.innerHTML = '<span class="d"></span>Verified pharmacy';
    } else {
      topPill.className = 'pill pill-none';
      topPill.innerHTML = '<span class="d"></span>Unverified pharmacy';
    }
  }

  function renderSubmissionHistory() {
    var st = getDemoState();
    var histEl = document.getElementById('pharmacy-submission-history');
    if (!histEl) return;
    var subs = (st.pharmacy && st.pharmacy.submissions) || [];
    histEl.innerHTML = '';
    if (subs.length === 0) {
      histEl.innerHTML = '<div style="padding:18px 4px;color:var(--ink-soft);font-size:.86rem;">No verification submissions yet.</div>';
      return;
    }
    subs.forEach(function (s, idx) {
      var div = document.createElement('div');
      div.style.cssText =
        'padding:12px 0;' +
        (idx < subs.length - 1 ? 'border-bottom:1px solid var(--line);' : '') +
        'display:flex;justify-content:space-between;align-items:center;font-size:.86rem;';
      div.innerHTML =
        '<div><b>' +
        escapeHtml(s.period || 'Current period records') +
        '</b><div style="color:var(--ink-soft);font-size:.78rem;">Submitted just now · ' +
        (s.items_scanned || 1) +
        ' items scanned</div></div>' +
        '<span class="pill pill-verified"><span class="d"></span>Matched</span>';
      histEl.appendChild(div);
    });
  }

  renderSubmissionHistory();

  var origSimScan = window.simulateStockScan;
  window.simulateStockScan = function () {
    if (typeof origSimScan === 'function') origSimScan();
    apiFetch('/api/check?q=8901234560013');
  };

  window.submitProof = async function () {
    var periodEl = document.getElementById('period');
    var notesEl = document.getElementById('pnotes');
    var scanCountEl = document.getElementById('scan-count');
    var boxes = document.querySelectorAll('.upload-box');
    var stockUrl = (boxes[0] && boxes[0].dataset.uploadedUrl) || 'https://example.com/proof/shelf-barcode-scan.jpg';
    var billingUrl = (boxes[1] && boxes[1].dataset.uploadedUrl) || 'https://example.com/proof/billing-export-30d.csv';

    var periodVal = (periodEl && periodEl.value.trim()) || '1–31 October 2026';
    var scannedCount = Math.max(1, Number((scanCountEl && scanCountEl.textContent) || 5));

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
        period: periodVal,
        notes: (notesEl && notesEl.value.trim()) || '',
        items_scanned: scannedCount,
        stock_proof_urls: [stockUrl],
        billing_proof_urls: [billingUrl],
      }),
    });

    var st = getDemoState();
    st.pharmacy.verified = true;
    st.pharmacy.verified_at = new Date().toISOString();
    st.pharmacy.items_scanned = scannedCount;
    st.pharmacy.period = periodVal;
    st.pharmacy.submissions.unshift({
      id: 'sub-' + Date.now(),
      period: periodVal,
      items_scanned: scannedCount,
      status: 'Matched',
      at: new Date().toISOString(),
    });
    saveDemoState(st);

    alert('Verification records submitted and matched! Your pharmacy is now marked Verified across Citizen, Pharmacy, and Government portals.');
    window.location.href = 'pharmacy-home.html';
  };
}

// ---------------------------------------------------------------------------
// 8. PHARMACY REPORTS PAGE (pharmacy-reports.html)
// ---------------------------------------------------------------------------
function initPharmacyReportsPage() {
  var activeFilter = 'all';
  var selectedReportId = null;

  function renderPharmacyReports() {
    var state = getDemoState();
    var isVer = Boolean(state.pharmacy && state.pharmacy.verified);
    var topPill = document.getElementById('pharmacy-reports-pill') || document.querySelector('.app-head .pill');
    if (topPill) {
      if (isVer) {
        topPill.className = 'pill pill-verified';
        topPill.innerHTML = '<span class="d"></span>Verified pharmacy';
      } else {
        topPill.className = 'pill pill-none';
        topPill.innerHTML = '<span class="d"></span>Unverified pharmacy';
      }
    }

    var reports = state.reports || [];
    var openCnt = reports.filter(function (r) { return !r.status || r.status === 'open' || r.status === 'escalated'; }).length;
    var progCnt = reports.filter(function (r) { return r.status === 'in_progress' || r.status === 'in progress'; }).length;
    var resCnt = reports.filter(function (r) { return r.status === 'resolved'; }).length;

    var chipAll = document.getElementById('pharm-chip-all');
    var chipOpen = document.getElementById('pharm-chip-open');
    var chipProg = document.getElementById('pharm-chip-progress');
    var chipRes = document.getElementById('pharm-chip-resolved');
    if (chipAll) chipAll.textContent = 'All (' + reports.length + ')';
    if (chipOpen) chipOpen.textContent = 'Open (' + openCnt + ')';
    if (chipProg) chipProg.textContent = 'In progress (' + progCnt + ')';
    if (chipRes) chipRes.textContent = 'Resolved (' + resCnt + ')';

    var filtered = reports.filter(function (r) {
      if (activeFilter === 'open') return !r.status || r.status === 'open' || r.status === 'escalated';
      if (activeFilter === 'progress') return r.status === 'in_progress' || r.status === 'in progress';
      if (activeFilter === 'resolved') return r.status === 'resolved';
      return true;
    });

    if (!selectedReportId && reports.length > 0) {
      var firstOpen = reports.find(function (r) { return r.status !== 'resolved'; }) || reports[0];
      selectedReportId = firstOpen.id;
    }

    var targetLabel = document.getElementById('pharmacy-respond-target');
    var selectedRep = reports.find(function (r) { return r.id === selectedReportId; }) || reports[0];
    if (targetLabel) {
      targetLabel.textContent = selectedRep
        ? 'Responding to: ' + selectedRep.medicine + ' — ' + getIssueTitle(selectedRep.issue_type)
        : 'Select or wait for a citizen report to respond';
    }

    var listEl = document.getElementById('pharmacy-reports-list');
    if (listEl) {
      listEl.innerHTML = '';
      if (filtered.length === 0) {
        listEl.innerHTML =
          '<div style="padding:28px 8px;text-align:center;color:var(--ink-soft);font-size:.9rem;">No citizen reports filed against your pharmacy yet.</div>';
      } else {
        filtered.forEach(function (rep) {
          var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
          var row = document.createElement('div');
          row.className = 'ledger-row';
          row.style.cursor = 'pointer';
          if (rep.id === selectedReportId) {
            row.style.background = '#fffaf5';
          }
          row.innerHTML =
            '<div class="ledger-thumb">₹</div>' +
            '<div class="l-main"><b>' +
            escapeHtml(rep.medicine) +
            ' — ' +
            getIssueTitle(rep.issue_type) +
            '</b><span>Filed just now · bill attached</span></div>' +
            '<div class="l-meta"><b>' +
            (over > 0 ? '₹' + over.toFixed(2) + ' over MRP' : 'Reported issue') +
            '</b>' +
            (rep.pharmacy_response ? 'You responded just now' : 'No response from you yet') +
            '</div>' +
            '<div class="l-meta"><b>' +
            (rep.status === 'resolved'
              ? 'Closed'
              : rep.pharmacy_response
              ? 'Govt. reviewing'
              : 'Pending reply') +
            '</b>BBMP Health Dept.</div>' +
            renderStatusPill(rep.status);

          row.addEventListener('click', function () {
            selectedReportId = rep.id;
            renderPharmacyReports();
          });
          listEl.appendChild(row);
        });
      }
    }
  }

  renderPharmacyReports();

  var chips = document.querySelectorAll('.filter-row .chip');
  chips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      if (label.indexOf('open') === 0) activeFilter = 'open';
      else if (label.indexOf('in progress') === 0) activeFilter = 'progress';
      else if (label.indexOf('resolved') === 0) activeFilter = 'resolved';
      else activeFilter = 'all';
      renderPharmacyReports();
    });
  });

  window.submitPharmacyResponse = async function () {
    var state = getDemoState();
    var reports = state.reports || [];
    if (reports.length === 0) {
      alert('There are no citizen reports to respond to yet. File a report from the Citizen portal first.');
      return;
    }
    var target =
      reports.find(function (r) { return r.id === selectedReportId; }) ||
      reports.find(function (r) { return r.status !== 'resolved'; }) ||
      reports[0];

    var respEl = document.getElementById('resp');
    var text = (respEl && respEl.value.trim()) || 'Corrected billing price to match registered MRP and updated shelf label.';
    var uploadBox = document.querySelector('.upload-box');
    var proofUrl = (uploadBox && uploadBox.dataset.uploadedUrl) || null;

    await apiFetch('/api/pharmacy/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_id: target.id,
        pharmacy_name: target.pharmacy || 'Sundar Medicals',
        response_text: text,
        proof_url: proofUrl,
      }),
    });

    target.pharmacy_response = {
      text: text,
      proof_url: proofUrl,
      at: new Date().toISOString(),
    };
    if (target.status === 'open') {
      target.status = 'in_progress';
    }
    saveDemoState(state);

    if (respEl) respEl.value = '';
    renderPharmacyReports();
    alert('Response sent. The Government portal and Citizen report pages have been updated with your response.');
  };
}

// ---------------------------------------------------------------------------
// 9. GOVERNMENT HOME PAGE (gov-home.html)
// ---------------------------------------------------------------------------
function initGovHomePage() {
  var searchInput = document.getElementById('gov-area-search') || document.querySelector('.search-bar input');
  var locateBtn = document.getElementById('gov-locate-btn');
  var searchBtn = document.getElementById('gov-search-btn') || document.querySelector('.search-bar .btn-primary');

  var activeStatusFilter = 'all';

  function renderGovHome() {
    var state = getDemoState();
    var q = (searchInput && searchInput.value.trim()) || 'Koramangala, Bengaluru';
    var reports = state.reports || [];
    var isPharmVerified = Boolean(state.pharmacy && state.pharmacy.verified);

    var openCnt = reports.filter(function (r) { return !r.status || r.status === 'open' || r.status === 'escalated'; }).length;
    var progCnt = reports.filter(function (r) { return r.status === 'in_progress' || r.status === 'in progress'; }).length;
    var resCnt = reports.filter(function (r) { return r.status === 'resolved'; }).length;
    var verCount = isPharmVerified ? 1 : 0;

    var stTotal = document.getElementById('gov-stat-total');
    var stOpen = document.getElementById('gov-stat-open');
    var stProg = document.getElementById('gov-stat-progress');
    var stRes = document.getElementById('gov-stat-resolved');
    var tabProb = document.getElementById('gov-tab-problems');
    var tabPharm = document.getElementById('gov-tab-pharmacies');
    var probHead = document.getElementById('gov-problems-heading') || document.querySelector('#gpane-issues .panel-head h2');
    var pharmHead = document.getElementById('gov-pharmacies-heading') || document.querySelector('#gpane-pharmacies .panel-head h2');

    if (stTotal) stTotal.textContent = String(reports.length);
    if (stOpen) stOpen.textContent = String(openCnt);
    if (stProg) stProg.textContent = String(progCnt);
    if (stRes) stRes.textContent = String(resCnt);
    if (tabProb) tabProb.textContent = 'Problems (' + reports.length + ')';
    if (tabPharm) tabPharm.textContent = 'Verified pharmacies (' + verCount + ')';

    var filtered = reports.filter(function (r) {
      if (activeStatusFilter === 'open') return !r.status || r.status === 'open' || r.status === 'escalated';
      if (activeStatusFilter === 'progress') return r.status === 'in_progress' || r.status === 'in progress';
      if (activeStatusFilter === 'resolved') return r.status === 'resolved';
      return true;
    });

    if (probHead) probHead.textContent = filtered.length + ' reports in ' + q;
    if (pharmHead) pharmHead.textContent = verCount + ' verified pharmacies in ' + q;

    var probList = document.getElementById('gov-problems-list');
    if (probList) {
      probList.innerHTML = '';
      if (filtered.length === 0) {
        probList.innerHTML =
          '<div style="padding:28px 8px;text-align:center;color:var(--ink-soft);font-size:.9rem;">No citizen reports in ' +
          escapeHtml(q) +
          ' yet. Once a citizen submits a report, it will appear here for review.</div>';
      } else {
        filtered.forEach(function (rep) {
          var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
          var a = document.createElement('a');
          a.className = 'ledger-row';
          a.href = 'gov-case.html?id=' + encodeURIComponent(rep.id);
          a.style.color = 'inherit';

          var midMeta = '<b>Awaiting your review</b>';
          if (rep.gov_updates && rep.gov_updates.length > 0) {
            var lastG = rep.gov_updates[rep.gov_updates.length - 1];
            midMeta = '<b>' + escapeHtml(lastG.status) + '</b>Updated by you';
          } else if (rep.pharmacy_response) {
            midMeta = '<b>Pharmacy responded</b>Just now';
          }

          a.innerHTML =
            '<div class="ledger-thumb">₹</div>' +
            '<div class="l-main"><b>' +
            escapeHtml(rep.medicine) +
            ' — ' +
            getIssueTitle(rep.issue_type) +
            '</b><span>' +
            escapeHtml(rep.pharmacy) +
            ', ' +
            escapeHtml(rep.address || q) +
            '</span></div>' +
            '<div class="l-meta"><b>' +
            (over > 0 ? '₹' + over.toFixed(2) + ' over MRP' : 'Reported issue') +
            '</b>Filed just now · bill attached</div>' +
            '<div class="l-meta">' +
            midMeta +
            '</div>' +
            renderStatusPill(rep.status);

          a.addEventListener('click', function () {
            sessionStorage.setItem('mc_gov_case_id', rep.id);
          });
          probList.appendChild(a);
        });
      }
    }

    var pharmList = document.getElementById('gov-pharmacies-list');
    if (pharmList) {
      pharmList.innerHTML = '';
      if (!isPharmVerified) {
        pharmList.innerHTML =
          '<div style="padding:28px 8px;text-align:center;color:var(--ink-soft);font-size:.9rem;">No verified pharmacies in ' +
          escapeHtml(q) +
          ' yet.</div>';
      } else {
        var pRow = document.createElement('div');
        pRow.className = 'pharm-row';
        pRow.innerHTML =
          '<div class="pharm-badge">✓</div>' +
          '<div class="p-main"><b>' +
          escapeHtml(state.pharmacy.name || 'Sundar Medicals') +
          '</b><span>' +
          escapeHtml(state.pharmacy.address || '12, 5th Block, Koramangala, Bengaluru 560095') +
          '</span></div>' +
          '<div class="p-meta"><b>Last verified</b>Just now (' +
          (state.pharmacy.items_scanned || 1) +
          ' items)</div>' +
          '<div class="p-meta"><b>' +
          openCnt +
          ' open reports</b>' +
          reports.length +
          ' total</div>' +
          '<span class="pill pill-verified"><span class="d"></span>Verified</span>';
        pharmList.appendChild(pRow);
      }
    }
  }

  renderGovHome();

  attachLocationAutocomplete(searchInput, locateBtn, function () {
    renderGovHome();
  });

  if (searchBtn) {
    searchBtn.addEventListener('click', function () {
      renderGovHome();
    });
  }
  if (searchInput) {
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        renderGovHome();
      }
    });
  }

  var chips = document.querySelectorAll('#gpane-issues .filter-row .chip');
  chips.forEach(function (chip) {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      var label = chip.textContent.trim().toLowerCase();
      if (label === 'open') activeStatusFilter = 'open';
      else if (label === 'in progress') activeStatusFilter = 'progress';
      else if (label === 'resolved') activeStatusFilter = 'resolved';
      else activeStatusFilter = 'all';
      renderGovHome();
    });
  });
}

// ---------------------------------------------------------------------------
// 10. GOVERNMENT CASE DETAIL PAGE (gov-case.html)
// ---------------------------------------------------------------------------
function initGovCasePage() {
  var params = new URLSearchParams(window.location.search);
  var requestedId = params.get('id') || sessionStorage.getItem('mc_gov_case_id');

  function renderGovCase() {
    var state = getDemoState();
    var reports = state.reports || [];
    var rep =
      (requestedId && reports.find(function (r) { return r.id === requestedId; })) ||
      reports[0] ||
      null;

    var titleEl = document.getElementById('gov-case-title') || document.querySelector('.app-head h1');
    var addrEl = document.getElementById('gov-case-address') || document.querySelector('.app-head p');
    var pillEl = document.getElementById('gov-case-status-pill') || document.querySelector('.app-head .pill');
    var billedEl = document.getElementById('gov-case-billed');
    var mrpEl = document.getElementById('gov-case-mrp');
    var overEl = document.getElementById('gov-case-overcharge');
    var filedEl = document.getElementById('gov-case-filed');
    var billPhotoEl = document.getElementById('gov-case-bill-photo');
    var pharmNameEl = document.getElementById('gov-case-pharm-name');
    var pharmStatusEl = document.getElementById('gov-case-pharm-status');
    var pharmOpenEl = document.getElementById('gov-case-pharm-open');
    var timelineEl = document.getElementById('gov-case-timeline') || document.querySelector('.timeline');

    if (!rep) {
      if (titleEl) titleEl.textContent = 'No report filed yet';
      if (addrEl) addrEl.textContent = 'File a report from the Citizen portal first to review it here.';
      return;
    }

    var over = Math.max(0, (Number(rep.billed) || 0) - (Number(rep.mrp) || 0));
    var isPharmVerified = Boolean(state.pharmacy && state.pharmacy.verified);
    var openCount = reports.filter(function (r) { return r.status !== 'resolved'; }).length;

    if (titleEl) titleEl.textContent = rep.medicine + ' — ' + getIssueTitle(rep.issue_type);
    if (addrEl) addrEl.textContent = (rep.pharmacy || 'Sundar Medicals') + ', ' + (rep.address || 'Koramangala, Bengaluru');

    if (pillEl) {
      var st = String(rep.status || 'open').toLowerCase();
      if (st === 'resolved') {
        pillEl.className = 'pill pill-resolved';
        pillEl.innerHTML = '<span class="d"></span>Resolved';
      } else if (st === 'in_progress' || st === 'in progress') {
        pillEl.className = 'pill pill-progress';
        pillEl.innerHTML = '<span class="d"></span>In progress';
      } else if (st === 'escalated') {
        pillEl.className = 'pill pill-open';
        pillEl.innerHTML = '<span class="d"></span>Escalated';
      } else {
        pillEl.className = 'pill pill-open';
        pillEl.innerHTML = '<span class="d"></span>Open';
      }
    }

    if (billedEl) billedEl.textContent = '₹' + Number(rep.billed).toFixed(2);
    if (mrpEl) mrpEl.textContent = '₹' + Number(rep.mrp).toFixed(2);
    if (overEl) overEl.textContent = over > 0 ? '₹' + over.toFixed(2) : '₹0.00';
    if (filedEl) filedEl.textContent = 'Just now';
    if (billPhotoEl) billPhotoEl.textContent = rep.bill_photo_name || 'attached bill.jpg';
    if (pharmNameEl) pharmNameEl.textContent = rep.pharmacy || 'Sundar Medicals';
    if (pharmStatusEl) {
      pharmStatusEl.textContent = isPharmVerified ? 'Verified' : 'Not verified';
      pharmStatusEl.style.color = isPharmVerified ? 'var(--ok)' : 'var(--ink-soft)';
    }
    if (pharmOpenEl) pharmOpenEl.textContent = String(openCount);

    if (timelineEl) {
      timelineEl.innerHTML = '';

      // Step 1: Citizen report filed
      var item1 = document.createElement('div');
      item1.className = 'tl-item';
      item1.innerHTML =
        '<div class="tl-dot">1</div>' +
        '<div class="tl-body">' +
        '<b>Report filed</b>' +
        '<span>Just now · citizen submission</span>' +
        '<p>' +
        escapeHtml(
          rep.notes ||
            'Billed ₹' +
              Number(rep.billed).toFixed(2) +
              ' against a registered MRP of ₹' +
              Number(rep.mrp).toFixed(2) +
              ', with a bill photo attached.'
        ) +
        '</p>' +
        '</div>';
      timelineEl.appendChild(item1);

      var stepCounter = 2;

      // Step 2: Pharmacy response (if any)
      if (rep.pharmacy_response) {
        var item2 = document.createElement('div');
        item2.className = 'tl-item';
        item2.innerHTML =
          '<div class="tl-dot">' +
          stepCounter +
          '</div>' +
          '<div class="tl-body">' +
          '<b>Pharmacy responded</b>' +
          '<span>Just now · ' +
          escapeHtml(rep.pharmacy || 'Sundar Medicals') +
          '</span>' +
          '<p>"' +
          escapeHtml(rep.pharmacy_response.text) +
          '"</p>' +
          '</div>';
        timelineEl.appendChild(item2);
        stepCounter++;
      }

      // Step 3+: Government updates
      if (rep.gov_updates && rep.gov_updates.length > 0) {
        rep.gov_updates.forEach(function (gu) {
          var isRes = String(gu.status || '').toLowerCase() === 'resolved';
          var gItem = document.createElement('div');
          gItem.className = 'tl-item' + (isRes ? ' resolved' : '');
          gItem.innerHTML =
            '<div class="tl-dot">' +
            (isRes ? '✓' : stepCounter) +
            '</div>' +
            '<div class="tl-body">' +
            '<b>BBMP Health Dept. — ' +
            escapeHtml(gu.status) +
            '</b>' +
            '<span>Just now · official government update</span>' +
            '<p>' +
            escapeHtml(gu.note) +
            '</p>' +
            '</div>';
          timelineEl.appendChild(gItem);
          stepCounter++;
        });
      } else {
        var waitItem = document.createElement('div');
        waitItem.className = 'tl-item resolved';
        waitItem.innerHTML =
          '<div class="tl-dot">·</div>' +
          '<div class="tl-body">' +
          '<b>Awaiting your update</b>' +
          '<span>Post a progress update on the right</span>' +
          '</div>';
        timelineEl.appendChild(waitItem);
      }
    }
  }

  renderGovCase();

  window.submitGovCaseUpdate = async function () {
    var state = getDemoState();
    var reports = state.reports || [];
    var rep =
      (requestedId && reports.find(function (r) { return r.id === requestedId; })) ||
      reports[0] ||
      null;

    if (!rep) {
      alert('No report found to update. File a report from the Citizen portal first.');
      return;
    }

    var statusEl = document.getElementById('status');
    var updateEl = document.getElementById('update');
    var uploadBox = document.querySelector('.upload-box');

    var uiStatus = (statusEl && statusEl.value) || 'In progress';
    var note =
      (updateEl && updateEl.value.trim()) ||
      'Inspector verified pricing and stock compliance at the pharmacy.';
    var proofUrl = (uploadBox && uploadBox.dataset.uploadedUrl) || null;

    await apiFetch('/api/government/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_id: rep.id,
        status: uiStatus,
        progress_note: note,
        proof_urls: proofUrl ? [proofUrl] : [],
        agency_name: 'BBMP Health Department',
      }),
    });

    if (!Array.isArray(rep.gov_updates)) rep.gov_updates = [];
    rep.gov_updates.push({
      status: uiStatus,
      note: note,
      proof_url: proofUrl,
      agency: 'BBMP Health Dept.',
      at: new Date().toISOString(),
    });

    var low = uiStatus.toLowerCase();
    if (low === 'resolved') rep.status = 'resolved';
    else if (low === 'escalated') rep.status = 'escalated';
    else rep.status = 'in_progress';

    saveDemoState(state);
    if (updateEl) updateEl.value = '';
    renderGovCase();
    alert('Progress update posted. Status is now "' + uiStatus + '" across Government, Pharmacy, and Citizen portals.');
  };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
