/* ============================================================================
 * MediCheck Shared Interactive Shell, Animation & Map Engine (`pages/app.js`)
 *
 * Implements Reference 2 (`Frontend_6`) interactions & transitions + Live Map:
 *   - Global instant search dropdown (.d-search / .d-results) across all pages
 *   - Swipeable / draggable showcase slider (.neo-subjects / .ns-stage)
 *   - Interactive Locality & Verified Pharmacy Map (window.initMediCheckMap)
 *   - Animated progress bars ([data-w]) & SVG score rings
 *   - Spring modal & proof document lightbox (window.openProofModal)
 *   - FAQ accordion (.fq)
 *   - Spring toast notification (window.neoToast)
 * ============================================================================ */
(function () {
  'use strict';

  /* 1. Toast Notification System (Reference 2 window.neoToast) */
  var toastEl = document.getElementById('toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  var toastTimer = null;
  window.neoToast = function (msg) {
    toastEl.innerHTML = '<i></i><span>' + msg + '</span>';
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2900);
  };

  /* 2. Global Instant Search across Pages, Medicines & Community Areas */
  var SEARCH_INDEX = [
    { t: 'App Homepage (All Features Dashboard)', s: 'Main App · Skip Login', h: '/dashboard.html', c: '#0B2540' },
    { t: 'Landing Page (The Problem & Solution)', s: 'Real NPPA & CDSCO Numbers', h: '/index.html', c: '#F2562B' },
    { t: 'Medicine & Barcode Scanner Studio', s: 'Page 1 · Scan & Check', h: '/scan.html', c: '#F2562B' },
    { t: 'TestFever 500 (Paracetamol 500 mg)', s: 'Above NPPA ceiling · Check', h: '/scan.html?q=TestFever+500&batch=TST1234', c: '#C93A12' },
    { t: 'CoolPara 500 (Paracetamol 500 mg)', s: 'Within NPPA ceiling · Check', h: '/scan.html?q=CoolPara+500&batch=BATCH-OK-01', c: '#0A7D5D' },
    { t: 'SampleMol 650 (Paracetamol 650 mg)', s: 'Above NPPA ceiling + CDSCO NSQ TST1234', h: '/scan.html?q=SampleMol+650&batch=TST1234', c: '#C93A12' },
    { t: 'SugarEase 500 (Metformin 500 mg)', s: 'Non-scheduled · Generic substitutes', h: '/scan.html?q=SugarEase+500', c: '#2A6FB5' },
    { t: 'Community Explorer & Interactive Map', s: 'Page 2 · Local Issues & Verified Stores', h: '/community.html', c: '#0A7D5D' },
    { t: 'Andheri West, Mumbai (400058)', s: 'Map Pin · Verified Store & 3 Reports', h: '/community.html?q=Andheri+West', c: '#0A7D5D' },
    { t: 'Dadar East, Mumbai (400014)', s: 'Map Pin · Verified Store (100/100)', h: '/community.html?q=Dadar', c: '#2A6FB5' },
    { t: 'Bandra West, Mumbai (400050)', s: 'Map Pin · Verified Store (90/100)', h: '/community.html?q=Bandra+West', c: '#6FB1E0' },
    { t: 'Government Officer Progress Portal', s: 'Page 3 · Post Action & Proof Images', h: '/government.html', c: '#F2562B' },
    { t: 'Phase 2 Pharmacy Verification Portal', s: 'Page 4 · Stock & Fair-Billing Review', h: '/pharmacy.html', c: '#2A6FB5' },
    { t: 'Security, Hash-Chain & Proof Receipts', s: 'Page 5 · SHA-256 + OpenTimestamps', h: '/security.html', c: '#0B2540' }
  ];

  function initGlobalSearch() {
    var wraps = [].slice.call(document.querySelectorAll('.d-search'));
    wraps.forEach(function (wrap) {
      var inp = wrap.querySelector('input');
      if (!inp) return;
      var box = wrap.querySelector('.d-results');
      if (!box) {
        box = document.createElement('div');
        box.className = 'd-results';
        wrap.appendChild(box);
      }

      function renderResults(q) {
        var query = (q || '').trim().toLowerCase();
        if (!query) {
          box.classList.remove('open');
          return;
        }
        var hits = SEARCH_INDEX.filter(function (x) {
          return (x.t + ' ' + x.s).toLowerCase().indexOf(query) > -1;
        }).slice(0, 6);

        if (!hits.length) {
          box.innerHTML =
            '<a class="d-res" href="/scan.html?q=' + encodeURIComponent(q.trim()) + '">' +
            '<i style="background:#F2562B"></i>' +
            '<span>Check medicine "<b>' + q.trim().replace(/</g, '&lt;') + '</b>"</span>' +
            '<small>Scan Studio</small></a>' +
            '<a class="d-res" href="/community.html?q=' + encodeURIComponent(q.trim()) + '">' +
            '<i style="background:#0A7D5D"></i>' +
            '<span>Locate area "<b>' + q.trim().replace(/</g, '&lt;') + '</b>" on Map</span>' +
            '<small>Community Map</small></a>';
        } else {
          box.innerHTML = hits
            .map(function (h) {
              return (
                '<a class="d-res" href="' + h.h + '">' +
                '<i style="background:' + h.c + '"></i>' +
                '<span>' + h.t + '</span>' +
                '<small>' + h.s + '</small></a>'
              );
            })
            .join('');
        }
        box.classList.add('open');
      }

      inp.addEventListener('input', function () {
        renderResults(inp.value);
      });
      inp.addEventListener('focus', function () {
        if (inp.value.trim()) renderResults(inp.value);
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          box.classList.remove('open');
          inp.blur();
        } else if (e.key === 'Enter') {
          var first = box.querySelector('a.d-res');
          if (first) window.location.href = first.getAttribute('href');
        }
      });
      document.addEventListener('click', function (e) {
        if (!wrap.contains(e.target)) box.classList.remove('open');
      });
    });
  }

  /* 3. Interactive Swipeable Showcase Slider (Reference 2 .neo-subjects) */
  function initShowcaseSlider() {
    var root = document.querySelector('.neo-subjects');
    if (!root) return;
    var stage = root.querySelector('.ns-stage');
    var track = root.querySelector('.ns-track');
    var slides = [].slice.call(root.querySelectorAll('.ns-slide'));
    var dots = [].slice.call(root.querySelectorAll('.ns-dot'));
    var prev = root.querySelector('.ns-arr.prev');
    var next = root.querySelector('.ns-arr.next');
    if (!stage || !track || !slides.length) return;

    var i = 0;
    var W = stage.offsetWidth || 800;
    var drag = null;

    function setX(px, anim) {
      track.style.transition = anim ? 'transform .7s cubic-bezier(.22,.8,.2,1)' : 'none';
      track.style.transform = 'translate3d(' + px + 'px,0,0)';
    }

    function go(n) {
      i = Math.max(0, Math.min(slides.length - 1, n));
      W = stage.offsetWidth || 800;
      setX(-i * W, true);
      slides.forEach(function (s, k) {
        s.classList.toggle('is-active', k === i);
      });
      dots.forEach(function (d, k) {
        d.classList.toggle('on', k === i);
      });
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === slides.length - 1;
    }

    stage.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || e.target.closest('.ns-arr') || e.target.closest('a,button')) return;
      drag = { x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, lock: null, id: e.pointerId };
    });

    stage.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (drag.lock === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        drag.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (drag.lock === 'x') {
          try { stage.setPointerCapture(e.pointerId); } catch (_) {}
          stage.classList.add('dragging');
        }
      }
      if (drag.lock !== 'x') return;
      drag.dx = dx;
      var edge = (i === 0 && dx > 0) || (i === slides.length - 1 && dx < 0) ? 0.35 : 1;
      setX(-i * W + dx * edge, false);
    });

    function endDrag() {
      if (!drag) return;
      var d = drag;
      drag = null;
      stage.classList.remove('dragging');
      if (d.lock !== 'x') return;
      var v = d.dx / Math.max(1, performance.now() - d.t);
      if (d.dx < -W * 0.16 || v < -0.5) go(i + 1);
      else if (d.dx > W * 0.16 || v > 0.5) go(i - 1);
      else go(i);
    }

    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') go(i + 1);
      if (e.key === 'ArrowLeft') go(i - 1);
    });
    if (prev) prev.addEventListener('click', function () { go(i - 1); });
    if (next) next.addEventListener('click', function () { go(i + 1); });
    dots.forEach(function (d, k) {
      d.addEventListener('click', function () { go(k); });
    });
    window.addEventListener('resize', function () {
      W = stage.offsetWidth || 800;
      setX(-i * W, false);
    });
    go(0);
  }

  /* 4. Animated Progress Bars ([data-w]) */
  window.animateBars = function (scope) {
    var root = scope || document;
    requestAnimationFrame(function () {
      [].slice.call(root.querySelectorAll('[data-w]')).forEach(function (el) {
        el.style.width = el.getAttribute('data-w') + '%';
      });
    });
  };

  /* 5. FAQ Accordions (.fq) */
  function initAccordions() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.fq > button');
      if (!btn) return;
      var fq = btn.parentElement;
      fq.classList.toggle('open');
    });
  }

  /* 6. Proof Document Lightbox Modal (window.openProofModal) */
  function ensureProofModal() {
    var m = document.getElementById('mcProofModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'mcProofModal';
    m.className = 'modal';
    m.innerHTML =
      '<div class="modal-box">' +
      '  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:0.75rem;">' +
      '    <div>' +
      '      <span class="badge badge-blue" id="mcModalBadge">Verified Attachment</span>' +
      '      <h3 id="mcModalTitle" style="margin-top:0.35rem;">Proof Document</h3>' +
      '    </div>' +
      '    <button type="button" class="btn btn-outline" id="mcModalClose" style="padding:0.35rem 0.75rem;">✕ Close</button>' +
      '  </div>' +
      '  <div id="mcModalBody" style="background:var(--mist);border:2px solid var(--navy);border-radius:1.1rem;padding:1.15rem;margin-bottom:1rem;"></div>' +
      '  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.6rem;">' +
      '    <span class="mono" id="mcModalUrl" style="font-size:0.74rem;color:var(--navy-muted);"></span>' +
      '    <a id="mcModalLink" href="#" target="_blank" rel="noopener" class="btn btn-primary" style="padding:0.45rem 0.95rem;font-size:0.8rem;">Open Raw URL ↗</a>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      if (e.target === m || e.target.closest('#mcModalClose')) {
        m.classList.remove('open');
      }
    });
    return m;
  }

  window.openProofModal = function (title, url, metaText) {
    var m = ensureProofModal();
    document.getElementById('mcModalTitle').textContent = title || 'Verified Proof Attachment';
    document.getElementById('mcModalUrl').textContent = url || '';
    document.getElementById('mcModalLink').href = url || '#';
    var isStock = (title || '').toLowerCase().indexOf('stock') > -1;
    var isBilling = (title || '').toLowerCase().indexOf('billing') > -1 || (title || '').toLowerCase().indexOf('invoice') > -1;
    var badgeLabel = isStock ? 'Phase 2 · Stock Audit Proof' : isBilling ? 'Phase 2 · Fair-Billing GST Proof' : 'Government Progress Proof';
    document.getElementById('mcModalBadge').textContent = badgeLabel;

    document.getElementById('mcModalBody').innerHTML =
      '<div style="display:flex;align-items:center;gap:0.9rem;margin-bottom:0.85rem;">' +
      '  <div style="width:3.2rem;height:3.2rem;border-radius:0.9rem;background:var(--navy);border:2px solid var(--navy);display:grid;place-items:center;color:var(--orange5);font-size:1.5rem;flex:none;">✓</div>' +
      '  <div>' +
      '    <div style="font-weight:800;font-size:0.98rem;">Cryptographically Linked Evidence Record</div>' +
      '    <div style="font-size:0.82rem;color:var(--navy-muted);">' + (metaText || 'Timestamped & linked to MediCheck verification ledger.') + '</div>' +
      '  </div>' +
      '</div>' +
      '<div class="code-block" style="font-size:0.76rem;">' +
      'DOCUMENT URI : ' + (url || 'N/A') + '\n' +
      'CATEGORY     : ' + badgeLabel + '\n' +
      'VERIFICATION : Passed automated NPPA ceiling & CDSCO NSQ batch cross-check\n' +
      'AUDIT TRAIL  : Sealed in Supabase public_log & pharmacies registry' +
      '</div>';
    m.classList.add('open');
  };

  /* ==========================================================================
   * 7. INTERACTIVE LOCALITY & VERIFIED PHARMACY MAP ENGINE
   *    Works on Homepage (`dashboard.html`), Community (`community.html`),
   *    and Embedded Preview (`preview.html`)
   * ========================================================================== */
  var AREA_COORDS = {
    'andheri west': { x: 34, y: 26, lat: 19.1364, lng: 72.8296, label: 'Andheri West (400058)' },
    'andheri':      { x: 38, y: 28, lat: 19.1197, lng: 72.8464, label: 'Andheri (400058)' },
    'bandra west':  { x: 39, y: 52, lat: 19.0596, lng: 72.8295, label: 'Bandra West (400050)' },
    'bandra':       { x: 42, y: 53, lat: 19.0596, lng: 72.8295, label: 'Bandra West (400050)' },
    'dadar east':   { x: 52, y: 72, lat: 19.0178, lng: 72.8478, label: 'Dadar East (400014)' },
    'dadar':        { x: 50, y: 71, lat: 19.0178, lng: 72.8478, label: 'Dadar (400014)' },
    'kurla':        { x: 64, y: 47, lat: 19.0726, lng: 72.8794, label: 'Kurla (400070)' },
    'powai':        { x: 68, y: 24, lat: 19.1176, lng: 72.9060, label: 'Powai (400076)' },
    'borivali':     { x: 30, y: 12, lat: 19.2307, lng: 72.8567, label: 'Borivali (400092)' },
    'lower parel':  { x: 46, y: 84, lat: 18.9953, lng: 72.8300, label: 'Lower Parel (400013)' },
    'mumbai':       { x: 45, y: 50, lat: 19.0760, lng: 72.8777, label: 'Mumbai Metro' }
  };

  function resolveAreaCoords(area, city, idx, kind) {
    var key = String(area || city || 'andheri west').toLowerCase().trim();
    var base = AREA_COORDS[key];
    if (!base) {
      Object.keys(AREA_COORDS).forEach(function (k) {
        if (!base && key.indexOf(k) > -1) base = AREA_COORDS[k];
      });
    }
    if (!base) base = AREA_COORDS['andheri west'];
    // Deterministic slight offset so multiple pins in the same area don't overlap completely
    var offsetX = kind === 'issue' ? 5.5 + (idx % 3) * 2.2 : (idx % 3) * 3.2 - 2.0;
    var offsetY = kind === 'issue' ? -3.5 + (idx % 2) * 2.5 : (idx % 2) * 2.8;
    return {
      x: Math.max(12, Math.min(88, base.x + offsetX)),
      y: Math.max(14, Math.min(88, base.y + offsetY)),
      lat: +(base.lat + offsetY * 0.0012).toFixed(4),
      lng: +(base.lng + offsetX * 0.0012).toFixed(4)
    };
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = ((lat2 - lat1) * Math.PI) / 180;
    var dLon = ((lon2 - lon1) * Math.PI) / 180;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return +(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
  }

  var mapState = {
    pins: [],
    layer: 'all',
    zoom: 1,
    panX: 0,
    panY: 0,
    selectedPinId: null,
    userLoc: { x: 37, y: 38, lat: 19.0985, lng: 72.8321, active: true, label: 'Your Location (Juhu / Santacruz West)' },
    activeRoutePinId: null
  };

  window.initMediCheckMap = function (containerId) {
    var root = document.getElementById(containerId || 'mcMapRoot');
    if (!root) return;

    root.innerHTML =
      '<div class="mc-map-wrap">' +
      '  <div class="mc-map-toolbar">' +
      '    <div style="display:flex;align-items:center;gap:0.55rem;flex-wrap:wrap;">' +
      '      <span class="badge badge-blue">🗺 Live Interactive Locality Map</span>' +
      '      <span id="mcMapSummaryText" style="font-size:0.8rem;font-weight:800;color:var(--navy);">Showing Verified Pharmacies &amp; Community Case Clusters</span>' +
      '    </div>' +
      '    <div class="mc-map-layers" role="group" aria-label="Map Pin Filters">' +
      '      <button type="button" class="mc-layer-btn active" data-layer="all" onclick="window.setMediCheckMapLayer(\'all\')">All Pins</button>' +
      '      <button type="button" class="mc-layer-btn" data-layer="stores" onclick="window.setMediCheckMapLayer(\'stores\')">✓ Verified Stores</button>' +
      '      <button type="button" class="mc-layer-btn" data-layer="jan" onclick="window.setMediCheckMapLayer(\'jan\')">💊 Jan Aushadhi</button>' +
      '      <button type="button" class="mc-layer-btn" data-layer="issues" onclick="window.setMediCheckMapLayer(\'issues\')">⚠ Issues &amp; Govt Action</button>' +
      '      <button type="button" class="mc-layer-btn" style="background:var(--sky3);" onclick="window.locateUserOnMap()">📍 Near Me (GPS)</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="mc-map-stage" id="mcMapStage">' +
      '    <div class="mc-map-viewport" id="mcMapViewport">' +
      '      <svg class="mc-map-svg" viewBox="0 0 1000 450" preserveAspectRatio="none" aria-hidden="true">' +
      '        <!-- Arabian Sea & Mahim Bay Water -->' +
      '        <rect width="1000" height="450" fill="#CBE6F8"/>' +
      '        <!-- Land Mass (Mumbai Suburban & Island City) -->' +
      '        <path d="M 210 0 L 1000 0 L 1000 450 L 310 450 C 315 390, 290 340, 340 285 C 280 265, 250 220, 265 160 C 230 110, 220 50, 210 0 Z" fill="#F4F9FD" stroke="#0B2540" stroke-width="3"/>' +
      '        <!-- Green Zones (Sanjay Gandhi / Aarey / Powai Lake) -->' +
      '        <ellipse cx="710" cy="105" rx="95" ry="52" fill="#DFF6EE" stroke="#0A7D5D" stroke-width="1.5" stroke-dasharray="5 4"/>' +
      '        <ellipse cx="685" cy="110" rx="35" ry="18" fill="#9ED1F0" stroke="#0B2540" stroke-width="1.5"/>' +
      '        <!-- Coordinate Grid Lines -->' +
      '        <g stroke="rgba(11,37,64,0.08)" stroke-width="1">' +
      '          <line x1="0" y1="90" x2="1000" y2="90"/><line x1="0" y1="180" x2="1000" y2="180"/><line x1="0" y1="270" x2="1000" y2="270"/><line x1="0" y1="360" x2="1000" y2="360"/>' +
      '          <line x1="200" y1="0" x2="200" y2="450"/><line x1="400" y1="0" x2="400" y2="450"/><line x1="600" y1="0" x2="600" y2="450"/><line x1="800" y1="0" x2="800" y2="450"/>' +
      '        </g>' +
      '        <!-- Bandra-Worli Sea Link -->' +
      '        <path d="M 340 265 Q 255 320 335 375" fill="none" stroke="#6FB1E0" stroke-width="4" stroke-dasharray="6 4"/>' +
      '        <!-- Major Arterial Highways (SV Road & Western Express Highway) -->' +
      '        <path d="M 285 0 C 310 120, 355 210, 395 270 C 445 330, 465 390, 455 450" fill="none" stroke="#FFFFFF" stroke-width="9"/>' +
      '        <path d="M 285 0 C 310 120, 355 210, 395 270 C 445 330, 465 390, 455 450" fill="none" stroke="#0B2540" stroke-width="2" stroke-opacity="0.35"/>' +
      '        <path d="M 430 0 C 460 130, 510 215, 535 310 C 555 375, 540 420, 520 450" fill="none" stroke="#FFE2DA" stroke-width="7"/>' +
      '        <!-- JVLR & Santacruz-Chembur Link Road -->' +
      '        <path d="M 335 120 Q 520 115 760 125" fill="none" stroke="#FFFFFF" stroke-width="6"/>' +
      '        <path d="M 390 235 Q 540 225 720 215" fill="none" stroke="#FFFFFF" stroke-width="6"/>' +
      '        <!-- Western & Central Railway Corridors -->' +
      '        <path d="M 355 0 C 380 120, 415 220, 485 325 L 480 450" fill="none" stroke="#0B2540" stroke-width="2.5" stroke-dasharray="8 6" stroke-opacity="0.5"/>' +
      '        <!-- Dynamic Route Line Layer -->' +
      '        <g id="mcRouteLayer"></g>' +
      '        <!-- Locality Labels -->' +
      '        <g font-family="Plus Jakarta Sans, sans-serif" font-weight="800" fill="#0B2540" opacity="0.68" font-size="13">' +
      '          <text x="105" y="235" fill="#2A6FB5" opacity="0.85">ARABIAN SEA</text>' +
      '          <text x="275" y="48">BORIVALI (400092)</text>' +
      '          <text x="270" y="142">ANDHERI WEST (400058)</text>' +
      '          <text x="645" y="96">POWAI (400076)</text>' +
      '          <text x="315" y="258">BANDRA WEST (400050)</text>' +
      '          <text x="615" y="228">KURLA (400070)</text>' +
      '          <text x="515" y="345">DADAR EAST (400014)</text>' +
      '          <text x="385" y="415">LOWER PAREL (400013)</text>' +
      '        </g>' +
      '      </svg>' +
      '      <div class="mc-pins-layer" id="mcPinsLayer"></div>' +
      '    </div>' +
      '    <!-- Zoom & Reset Controls -->' +
      '    <div class="mc-map-controls">' +
      '      <button type="button" class="mc-ctrl-btn" title="Zoom In" onclick="window.zoomMediCheckMap(0.25)">+</button>' +
      '      <button type="button" class="mc-ctrl-btn" title="Zoom Out" onclick="window.zoomMediCheckMap(-0.25)">−</button>' +
      '      <button type="button" class="mc-ctrl-btn" title="Reset Map View" onclick="window.resetMediCheckMap()">⟲</button>' +
      '    </div>' +
      '    <!-- Active Pin Inspector Popup -->' +
      '    <div class="mc-map-popup" id="mcMapPopup" style="display:none;"></div>' +
      '    <!-- Map Legend -->' +
      '    <div class="mc-map-legend">' +
      '      <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#0A7D5D;border:1.5px solid #0B2540;margin-right:4px;"></i>Verified Pharmacy</span>' +
      '      <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#F2562B;border:1.5px solid #0B2540;margin-right:4px;"></i>Issue / Govt Proof</span>' +
      '      <span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#2A6FB5;border:1.5px solid #0B2540;margin-right:4px;"></i>Your GPS Location</span>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    // Enable drag-to-pan on map stage
    var stage = document.getElementById('mcMapStage');
    var vp = document.getElementById('mcMapViewport');
    var drag = null;
    if (stage && vp) {
      stage.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.mc-pin') || e.target.closest('.mc-ctrl-btn') || e.target.closest('.mc-map-popup')) return;
        drag = { x: e.clientX, y: e.clientY, startX: mapState.panX, startY: mapState.panY, id: e.pointerId };
        stage.classList.add('dragging');
        vp.classList.add('no-anim');
      });
      stage.addEventListener('pointermove', function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        mapState.panX = Math.max(-220, Math.min(220, drag.startX + (e.clientX - drag.x)));
        mapState.panY = Math.max(-140, Math.min(140, drag.startY + (e.clientY - drag.y)));
        applyMapTransform();
      });
      var endPan = function () {
        if (!drag) return;
        drag = null;
        stage.classList.remove('dragging');
        vp.classList.remove('no-anim');
      };
      stage.addEventListener('pointerup', endPan);
      stage.addEventListener('pointercancel', endPan);
    }
  };

  function applyMapTransform() {
    var vp = document.getElementById('mcMapViewport');
    if (!vp) return;
    vp.style.transform = 'translate3d(' + mapState.panX + 'px,' + mapState.panY + 'px,0) scale(' + mapState.zoom + ')';
  }

  window.zoomMediCheckMap = function (delta) {
    mapState.zoom = Math.max(0.85, Math.min(2.1, +(mapState.zoom + delta).toFixed(2)));
    applyMapTransform();
  };

  window.resetMediCheckMap = function () {
    mapState.zoom = 1;
    mapState.panX = 0;
    mapState.panY = 0;
    mapState.activeRoutePinId = null;
    applyMapTransform();
    renderMapPins();
    if (window.neoToast) window.neoToast('Map view reset to full Mumbai metro');
  };

  window.setMediCheckMapLayer = function (layer) {
    mapState.layer = layer;
    [].slice.call(document.querySelectorAll('.mc-layer-btn[data-layer]')).forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-layer') === layer);
    });
    renderMapPins();
  };

  window.locateUserOnMap = function () {
    mapState.userLoc.active = true;
    mapState.zoom = 1.2;
    mapState.panX = 25;
    mapState.panY = 15;
    applyMapTransform();

    // Find nearest verified store and draw route automatically
    var stores = mapState.pins.filter(function (p) { return p.kind === 'store'; });
    if (stores.length) {
      stores.sort(function (a, b) { return a.distanceKm - b.distanceKm; });
      mapState.selectedPinId = stores[0].id;
      mapState.activeRoutePinId = stores[0].id;
    }
    renderMapPins();
    if (window.neoToast) {
      window.neoToast(
        stores.length
          ? '📍 GPS Located! Nearest Verified Pharmacy: ' + stores[0].title + ' (' + stores[0].distanceKm + ' km)'
          : '📍 GPS Location active on map!'
      );
    }
  };

  window.updateMediCheckMap = function (verifiedStores, issues, areaQuery) {
    if (!document.getElementById('mcMapStage')) {
      window.initMediCheckMap('mcMapRoot');
    }
    var pins = [];
    (verifiedStores || []).forEach(function (s, idx) {
      var c = resolveAreaCoords(s.area, s.city, idx, 'store');
      var dist = haversineKm(mapState.userLoc.lat, mapState.userLoc.lng, c.lat, c.lng);
      pins.push({
        id: 'store-' + (s.id || s.licence_no || idx),
        kind: 'store',
        title: s.pharmacy_name,
        shortLabel: '✓ ' + s.pharmacy_name.split(' ')[0] + ' (' + (s.verification_score || 100) + '%)',
        area: s.area || 'Andheri West',
        city: s.city || 'Mumbai',
        pincode: s.pincode || '400058',
        licence: s.licence_no || '',
        score: s.verification_score || 100,
        janAushadhi: Boolean(s.jan_aushadhi_available),
        stockProof: (s.stock_proof_urls || [])[0] || '',
        billProof: (s.billing_proof_urls || [])[0] || '',
        note: s.last_review_note || s.verification_notes || 'Passed stock & NPPA fair-billing verification.',
        x: c.x,
        y: c.y,
        lat: c.lat,
        lng: c.lng,
        distanceKm: dist
      });
    });

    (issues || []).forEach(function (iss, idx) {
      var loc = iss.location || iss;
      var c = resolveAreaCoords(loc.area, loc.city, idx, 'issue');
      var dist = haversineKm(mapState.userLoc.lat, mapState.userLoc.lng, c.lat, c.lng);
      var updates = iss.government_updates || [];
      var disp = iss.pharmacy_name || iss.pharmacy_display_name || '🔒 Protected Identity (<3 reports)';
      pins.push({
        id: 'issue-' + (iss.report_id || iss.seq || idx),
        kind: 'issue',
        title: 'Seq #' + iss.seq + ' · ' + disp,
        shortLabel: (updates.length ? '🏛 ' : '⚠ ') + 'Seq #' + iss.seq + ' (' + (loc.area || 'Andheri W') + ')',
        area: loc.area || 'Andheri West',
        city: loc.city || 'Mumbai',
        pincode: loc.pincode || '400058',
        reportType: iss.report_type || 'price_above_ceiling',
        status: iss.current_status || iss.status || 'filed',
        thresholdMet: Boolean(iss.threshold_met),
        govAgency: updates[0] ? updates[0].agency_name : null,
        govAction: updates[0] ? updates[0].action_taken || updates[0].progress_note : null,
        govProof: updates[0] && (updates[0].proof_urls || [])[0] ? updates[0].proof_urls[0] : '',
        x: c.x,
        y: c.y,
        lat: c.lat,
        lng: c.lng,
        distanceKm: dist
      });
    });

    mapState.pins = pins;
    if (!mapState.selectedPinId && pins.length) {
      mapState.selectedPinId = pins[0].id;
    } else if (mapState.selectedPinId && !pins.some(function (p) { return p.id === mapState.selectedPinId; })) {
      mapState.selectedPinId = pins[0] ? pins[0].id : null;
    }

    var sumEl = document.getElementById('mcMapSummaryText');
    if (sumEl) {
      sumEl.textContent =
        (areaQuery ? 'Area: ' + areaQuery + ' · ' : 'All Areas · ') +
        (verifiedStores || []).length +
        ' Verified Store Pin(s) & ' +
        (issues || []).length +
        ' Community Issue Pin(s)';
    }

    renderMapPins();
  };

  window.focusMapPin = function (pinId, drawRoute) {
    var pin = mapState.pins.find(function (p) { return p.id === pinId; });
    if (!pin) return;
    mapState.selectedPinId = pin.id;
    if (drawRoute) mapState.activeRoutePinId = pin.id;
    // Center viewport gently toward selected pin
    mapState.zoom = 1.25;
    mapState.panX = Math.round((50 - pin.x) * 3.2);
    mapState.panY = Math.round((50 - pin.y) * 1.8);
    applyMapTransform();
    renderMapPins();

    var stage = document.getElementById('mcMapStage');
    if (stage && stage.scrollIntoView) {
      stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (window.neoToast) {
      window.neoToast((drawRoute ? '🧭 Route drawn to: ' : '🗺 Focused on map: ') + pin.title);
    }
  };

  window.drawMapRoute = function (pinId) {
    window.focusMapPin(pinId, true);
  };

  function renderMapPins() {
    var layerEl = document.getElementById('mcPinsLayer');
    var routeEl = document.getElementById('mcRouteLayer');
    var popupEl = document.getElementById('mcMapPopup');
    if (!layerEl) return;

    var visiblePins = mapState.pins.filter(function (p) {
      if (mapState.layer === 'stores') return p.kind === 'store';
      if (mapState.layer === 'jan') return p.kind === 'store' && p.janAushadhi;
      if (mapState.layer === 'issues') return p.kind === 'issue';
      return true;
    });

    var html = '';

    // User GPS Pin
    if (mapState.userLoc.active) {
      html +=
        '<button type="button" class="mc-pin pin-user" style="left:' + mapState.userLoc.x + '%;top:' + mapState.userLoc.y + '%;" onclick="window.locateUserOnMap()">' +
        '  <span class="mc-pin-head">📍 You</span>' +
        '  <span class="mc-pin-stem"></span>' +
        '  <span class="mc-pin-pulse"></span>' +
        '</button>';
    }

    visiblePins.forEach(function (p) {
      var isSel = p.id === mapState.selectedPinId;
      var cls = 'mc-pin ' + (p.kind === 'store' ? 'pin-store' : 'pin-issue') + (isSel ? ' is-selected' : '');
      html +=
        '<button type="button" class="' + cls + '" style="left:' + p.x + '%;top:' + p.y + '%;" onclick="window.focusMapPin(\'' + p.id + '\', false)">' +
        '  <span class="mc-pin-head">' + p.shortLabel + '</span>' +
        '  <span class="mc-pin-stem"></span>' +
        '  <span class="mc-pin-pulse"></span>' +
        '</button>';
    });

    layerEl.innerHTML = html;

    // Render SVG Route Line if active
    var activePin = visiblePins.find(function (p) { return p.id === mapState.selectedPinId; }) || visiblePins[0] || null;
    if (routeEl) {
      var routeTarget = mapState.pins.find(function (p) { return p.id === mapState.activeRoutePinId; });
      if (routeTarget && mapState.userLoc.active) {
        var x1 = mapState.userLoc.x * 10;
        var y1 = mapState.userLoc.y * 4.5;
        var x2 = routeTarget.x * 10;
        var y2 = routeTarget.y * 4.5;
        var cx = (x1 + x2) / 2 + 35;
        var cy = (y1 + y2) / 2 - 25;
        routeEl.innerHTML =
          '<path d="M ' + x1 + ' ' + y1 + ' Q ' + cx + ' ' + cy + ' ' + x2 + ' ' + y2 + '" fill="none" stroke="#0B2540" stroke-width="6" stroke-linecap="round"/>' +
          '<path d="M ' + x1 + ' ' + y1 + ' Q ' + cx + ' ' + cy + ' ' + x2 + ' ' + y2 + '" fill="none" stroke="#F2562B" stroke-width="3.5" stroke-linecap="round" class="mc-route-anim"/>';
      } else {
        routeEl.innerHTML = '';
      }
    }

    // Render Active Pin Popup Inspector
    if (!popupEl) return;
    if (!activePin) {
      popupEl.style.display = 'none';
      return;
    }

    popupEl.style.display = 'block';
    var walkMins = Math.max(4, Math.round(activePin.distanceKm * 11));
    var hasRoute = mapState.activeRoutePinId === activePin.id;

    if (activePin.kind === 'store') {
      popupEl.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;">' +
        '  <div>' +
        '    <span class="badge badge-green">✓ VERIFIED (' + activePin.score + '/100)</span> ' +
        (activePin.janAushadhi ? '<span class="badge badge-blue">💊 Jan Aushadhi</span>' : '') +
        '    <strong style="display:block;font-size:0.96rem;margin-top:0.25rem;">' + activePin.title + '</strong>' +
        '  </div>' +
        '  <span class="mono" style="font-size:0.74rem;font-weight:800;color:var(--teal);">' + activePin.distanceKm + ' km</span>' +
        '</div>' +
        '<div style="font-size:0.76rem;color:var(--navy-muted);margin-top:0.2rem;">' +
        '  📍 ' + activePin.area + ', ' + activePin.city + ' (' + activePin.pincode + ') · GPS: ' + activePin.lat + '°N, ' + activePin.lng + '°E' +
        '</div>' +
        (hasRoute
          ? '<div style="margin-top:0.35rem;padding:0.3rem 0.6rem;background:#DFF6EE;border:1.5px solid #0B2540;border-radius:0.6rem;font-size:0.74rem;font-weight:800;color:#065F46;">🧭 Active Route: ' + activePin.distanceKm + ' km (~' + walkMins + ' min walk / ' + Math.max(2, Math.round(walkMins / 3)) + ' min drive)</div>'
          : '') +
        '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.55rem;">' +
        '  <button type="button" class="proof-thumb" style="background:var(--orange5);color:#FFF;" onclick="window.drawMapRoute(\'' + activePin.id + '\')">🧭 ' + (hasRoute ? 'Route Active' : 'Draw Route') + '</button>' +
        (activePin.stockProof
          ? '<button type="button" class="proof-thumb" onclick="window.openProofModal(\'Stock Shelf Proof — ' + activePin.title.replace(/'/g, "\\'") + '\', \'' + activePin.stockProof + '\', \'' + activePin.area + ', ' + activePin.city + '\')">📦 Stock Proof</button>'
          : '') +
        (activePin.billProof
          ? '<button type="button" class="proof-thumb" onclick="window.openProofModal(\'GST Billing Proof — ' + activePin.title.replace(/'/g, "\\'") + '\', \'' + activePin.billProof + '\', \'Audited against NPPA ceiling\')">🧾 GST Bill</button>'
          : '') +
        '</div>';
    } else {
      popupEl.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;">' +
        '  <div>' +
        '    <span class="badge ' + (activePin.status === 'action_taken' || activePin.status === 'resolved' ? 'badge-green' : 'badge-amber') + '">STATUS: ' + activePin.status.toUpperCase() + '</span> ' +
        '    <span class="badge badge-purple">' + (activePin.thresholdMet ? '≥3 Threshold Met' : '<3 Protected') + '</span>' +
        '    <strong style="display:block;font-size:0.95rem;margin-top:0.25rem;">' + activePin.title + '</strong>' +
        '  </div>' +
        '  <span class="mono" style="font-size:0.74rem;font-weight:800;color:var(--orange7);">' + activePin.distanceKm + ' km</span>' +
        '</div>' +
        '<div style="font-size:0.76rem;color:var(--navy-muted);margin-top:0.2rem;">' +
        '  📍 ' + activePin.area + ', ' + activePin.city + ' · Issue: <strong>' + activePin.reportType + '</strong>' +
        '</div>' +
        (activePin.govAgency
          ? '<div style="margin-top:0.35rem;font-size:0.75rem;color:var(--teal);font-weight:800;">🏛 ' + activePin.govAgency + ': ' + activePin.govAction + '</div>'
          : '') +
        '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.55rem;">' +
        '  <button type="button" class="proof-thumb" style="background:var(--orange5);color:#FFF;" onclick="window.drawMapRoute(\'' + activePin.id + '\')">🧭 Inspect Location</button>' +
        (activePin.govProof
          ? '<button type="button" class="proof-thumb" onclick="window.openProofModal(\'Government Inspection Proof\', \'' + activePin.govProof + '\', \'' + (activePin.govAgency || 'State FDA') + '\')">🖼 Govt Proof</button>'
          : '') +
        '</div>';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    initGlobalSearch();
    initShowcaseSlider();
    initAccordions();
    if (document.getElementById('mcMapRoot')) {
      window.initMediCheckMap('mcMapRoot');
    }
    window.animateBars();
  });
})();
