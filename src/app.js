/* app.js — UI wiring for qBruce. One SerialManager drives every panel. */
(() => {
  const S = new SerialManager();
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = window.__sleep;

  /* Desktop feel: block native drag of images/text, and the browser context menu
     everywhere except real text areas (where copy/paste is still handy). */
  document.addEventListener('dragstart', e => e.preventDefault());
  document.addEventListener('contextmenu', e => {
    if (!(e.target.closest && e.target.closest('input, textarea, .term, #logPre'))) e.preventDefault();
  });

  /* App version from package.json (exposed by preload in Electron); the HTML
     text is the fallback for a plain browser. */
  (() => {
    const v = window.appInfo && window.appInfo.version;
    if (!v) return;
    const tag = 'v' + v;
    const a = $('#appVersion'); if (a) a.textContent = tag;
    const b = $('#aboutVersion'); if (b) b.textContent = tag;
  })();

  let renderer = null;
  let screenStreaming = false;
  let detectedDeviceName = '';   // from `info` Device field, used to auto-filter the store

  /* inline line-icons (no emoji) */
  const ICON = {
    folder: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 4.5a1 1 0 0 1 1-1h2.6l1 1.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
    file:   '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13z"/><path d="M9 2.5v3h3"/></svg>',
    eye:    '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>',
    dl:     '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3" x2="8" y2="10"/><polyline points="5 7.5 8 10.5 11 7.5"/><line x1="3.5" y1="12.5" x2="12.5" y2="12.5"/></svg>',
    pen:    '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M11 2.5 13.5 5 6 12.5 3 13l.5-3z"/></svg>',
    trash:  '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5"/></svg>',
    play:   '<svg class="ic" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 3v10l8-5z"/></svg>',
  };

  /* ---------------- toasts ---------------- */
  function toast(msg, type = '', ms = 3200) {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setStatus(msg, type);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(30px)'; setTimeout(() => t.remove(), 250); }, ms);
  }
  function setStatus(msg, type = '') {
    const s = $('#statusMsg'); if (s) s.innerHTML = '<span class="si">i</span> ' + esc(String(msg).toUpperCase());
    const bar = document.querySelector('.logbar');
    if (bar) { bar.classList.remove('ok', 'err', 'busy'); if (type === 'ok' || type === 'err') bar.classList.add(type); }
  }

  /* themed dialogs (replace the native confirm/prompt/alert, which use the OS theme) */
  function uiDialog({ title, message, input, inputValue, okText, cancelText, danger }) {
    return new Promise(resolve => {
      const ov = $('#uiDialog'), inp = $('#uiDlgInput'), ok = $('#uiDlgOk'), cancel = $('#uiDlgCancel');
      $('#uiDlgTitle').textContent = title || 'Confirm';
      const msgEl = $('#uiDlgMsg'); msgEl.textContent = message || ''; msgEl.style.display = message ? '' : 'none';
      if (input) { inp.style.display = ''; inp.value = inputValue || ''; } else inp.style.display = 'none';
      ok.textContent = okText || 'OK'; ok.className = 'btn ' + (danger ? 'danger' : 'primary');
      cancel.textContent = cancelText || 'CANCEL'; cancel.style.display = cancelText === null ? 'none' : '';
      ov.style.display = '';
      if (input) setTimeout(() => { inp.focus(); inp.select(); }, 60);
      const done = v => { ov.style.display = 'none'; ok.onclick = cancel.onclick = inp.onkeydown = null; resolve(v); };
      ok.onclick = () => done(input ? inp.value : true);
      cancel.onclick = () => done(input ? null : false);
      inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } else if (e.key === 'Escape') done(null); };
    });
  }
  const uiConfirm = (message, title = 'Confirm', danger = false) => uiDialog({ title, message, okText: 'YES', cancelText: 'CANCEL', danger });
  const uiPrompt = (message, def = '', title = 'Input') => uiDialog({ title, message, input: true, inputValue: def, okText: 'OK', cancelText: 'CANCEL' });
  const uiAlert = (message, title = 'Notice') => uiDialog({ title, message, okText: 'OK', cancelText: null });

  /* LOGS drawer — mirrors the raw serial feed */
  (function logDrawer() {
    const pre = $('#logPre'); let buf = '';
    S.subText(txt => {
      buf += txt; if (buf.length > 14000) buf = buf.slice(-14000);
      if (pre) { pre.textContent = buf; if ($('#logDrawer').classList.contains('open')) pre.scrollTop = pre.scrollHeight; }
    });
    $('#btnLogs').addEventListener('click', () => {
      const d = $('#logDrawer'); d.classList.toggle('open');
      $('#btnLogs').textContent = (d.classList.contains('open') ? '▴ LOGS' : '▾ LOGS');
      if (d.classList.contains('open') && pre) pre.scrollTop = pre.scrollHeight;
    });
  })();

  /* ---------------- tab switching ---------------- */
  $$('.nav-item').forEach(it => it.addEventListener('click', () => {
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    it.classList.add('active');
    const name = it.dataset.panel;
    $$('.panel').forEach(p => p.classList.remove('active'));
    $('#panel-' + name).classList.add('active');
    if (name === 'terminal') setTimeout(() => $('#termInput').focus(), 50);
  }));

  /* ---------------- Electron serial-port picker ---------------- */
  if (window.electronSerial && window.electronSerial.isElectron) {
    const overlay = $('#portOverlay'), listEl = $('#portList');
    window.electronSerial.onPorts(ports => {
      if (!ports.length) { window.electronSerial.select(''); toast('No serial ports found', 'err'); return; }
      listEl.innerHTML = ports.map(p => {
        const name = p.displayName || p.portName || p.portId;
        const vid = p.vendorId ? ` · VID:${p.vendorId} PID:${p.productId}` : '';
        return `<div class="menu-opt" data-id="${p.portId}"><span class="idx">▸</span>${esc(name)}<span style="color:var(--text-faint);font-size:11px;margin-left:auto">${esc(vid)}</span></div>`;
      }).join('');
      overlay.style.display = '';
      $$('.menu-opt', listEl).forEach(el => el.addEventListener('click', () => {
        overlay.style.display = 'none';
        window.electronSerial.select(el.dataset.id);
      }));
    });
    $('#portCancel').addEventListener('click', () => { overlay.style.display = 'none'; window.electronSerial.select(''); });
  }

  /* ---------------- custom window controls (frameless Electron) ---------------- */
  if (window.winControls) {
    $('#winControls').style.display = 'flex';
    $('#winMin').addEventListener('click', () => window.winControls.minimize());
    $('#winClose').addEventListener('click', () => window.winControls.close());
  }

  /* ---------------- connection ---------------- */
  S.subStatus(connected => {
    $('#devChip').classList.toggle('on', connected);
    $('#btnConnect').style.display = connected ? 'none' : '';
    $('#btnDisconnect').style.display = connected ? '' : 'none';
    $('#connectOverlay').style.display = connected ? 'none' : '';
    const badge = $('#connBadge');
    if (connected) {
      $('#connText').textContent = 'CONNECTED'; badge.classList.remove('off');
      $('#connPath').textContent = 'USB · 115200';
    } else {
      $('#devChipText').textContent = 'DISCONNECTED';
      $('#connText').textContent = 'DISCONNECTED'; badge.classList.add('off');
      $('#connPath').textContent = ''; $('#deviceNameBig').textContent = 'BRUCE';
      $('#deviceImg').src = 'assets/bruce-device.png';
    }
  });

  /* dashboard device actions */
  $('#btnReboot').addEventListener('click', async () => {
    if (!S.connected) return toast('Connect first', 'err');
    if (!(await uiConfirm('Reboot the device?', 'Reboot'))) return;
    await S.sendCommand('power reboot', { silence: 300, timeout: 2000 }); toast('Reboot sent', 'ok');
  });
  $('#btnFactory').addEventListener('click', async () => {
    if (!S.connected) return toast('Connect first', 'err');
    if (!(await uiConfirm('Factory reset resets Bruce.conf. Continue?', 'Factory reset', true))) return;
    await S.sendCommand('factory_reset', { silence: 400 }); toast('Factory reset sent', 'ok');
  });
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => {
    const el = document.querySelector('.nav-item[data-panel="' + b.dataset.goto + '"]'); if (el) el.click();
  }));

  $('#btnConnect').addEventListener('click', async () => {
    try {
      $('#devChipText').textContent = 'Connecting…';
      await S.connect(115200);
      toast('Connected', 'ok');
      term.sys('— connected @ 115200 —');
      await sleep(300);
      await loadDashboard();
    } catch (e) {
      $('#devChipText').textContent = 'Disconnected';
      toast(e.message || 'Connection failed', 'err', 5000);
    }
  });
  $('#btnDisconnect').addEventListener('click', async () => {
    await stopScreen();
    await S.disconnect();
    toast('Disconnected');
  });

  /* ================= TERMINAL ================= */
  const term = (() => {
    const view = $('#termView');
    const input = $('#termInput');
    let lineBuf = '';
    let history = []; let hIdx = -1;
    const MAX = 4000;

    function append(cls, text) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = text;
      view.appendChild(div);
      while (view.children.length > MAX) view.removeChild(view.firstChild);
      view.scrollTop = view.scrollHeight;
    }
    function classify(line) {
      const t = line.trim();
      if (t.startsWith('COMMAND:')) return 'l-cmd';
      if (t.startsWith('ERROR:') || /error/i.test(t)) return 'l-err';
      if (t.startsWith('[CLI] Result: TRUE')) return 'l-ok';
      if (t.startsWith('#')) return 'l-sys';
      return '';
    }
    // feed raw serial text, split into lines
    S.subText(text => {
      lineBuf += text;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop();
      for (const l of parts) append(classify(l), l.replace(/\r$/, ''));
    });

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const cmd = input.value.trim();
        if (!cmd) return;
        history.unshift(cmd); hIdx = -1; input.value = '';
        if (!S.connected) { toast('Not connected', 'err'); return; }
        append('l-cmd', cmd);
        try { await S.sendCommand(cmd); } catch (err) { append('l-err', String(err)); }
      } else if (e.key === 'ArrowUp') {
        if (hIdx < history.length - 1) { hIdx++; input.value = history[hIdx]; }
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (hIdx > 0) { hIdx--; input.value = history[hIdx]; } else { hIdx = -1; input.value = ''; }
        e.preventDefault();
      }
    });
    $('#btnTermClear').addEventListener('click', () => view.innerHTML = '');
    $('#btnTermHelp').addEventListener('click', () => { if (S.connected) { append('l-cmd', 'help'); S.sendCommand('help'); } });

    return { sys: (m) => append('l-sys', m), raw: append };
  })();

  /* ================= DASHBOARD ================= */
  /* pick the themed device illustration for the connected device (falls back to the Bruce shark) */
  function deviceImageFor(name) {
    const n = (name || '').toLowerCase();
    const map = [
      [/cardputer/, 'cardputer'],
      [/t-?deck|t-?keyboard/, 'tdeck'],
      [/cyd|2432s028|3248s035|cheap\s*yellow/, 'cyd'],
      [/core\s*s3|cores3|core2|core|m5stack\s*core/, 'core'],
      [/stick/, 'stick'],
      [/reaper/, 'reaper'],
      [/t-?embed/, 'tembed'],
    ];
    for (const [re, f] of map) if (re.test(n)) return 'assets/devices/' + f + '.png';
    return 'assets/bruce-device.png';
  }
  async function loadDashboard() {
    if (!S.connected) return;
    const info = $('#infoCard'), res = $('#resCard');
    info.innerHTML = '<div class="empty"><span class="spinner"></span> loading…</div>';
    try {
      const infoTxt = await S.sendCommand('info', { silence: 500 });
      const freeTxt = await S.sendCommand('free', { silence: 500 });
      const sdTxt = await S.sendCommand('storage free sd', { silence: 500 });
      const fsTxt = await S.sendCommand('storage free littlefs', { silence: 500 });
      renderInfo(info, infoTxt);
      renderRes(res, freeTxt);
      renderStorage(sdTxt, fsTxt);
      // device name (chip + big home title)
      const dev = pick(infoTxt, 'Device') || firstMeaningful(infoTxt) || 'Bruce';
      $('#devChipText').textContent = dev.toUpperCase();
      $('#deviceNameBig').textContent = dev;
      $('#deviceImg').src = deviceImageFor(dev);
      detectedDeviceName = dev;
      if (storeLoaded) {                 // re-apply the device filter to an already-open store
        selStoreDevice = matchStoreDevice(dev);
        const sel = $('#storeDevice'); if (sel) sel.value = selStoreDevice;
        renderStore();
      }
    } catch (e) { info.innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`; }
  }
  function firstMeaningful(txt) { return (txt.split('\n').map(s=>s.trim()).filter(Boolean)[0]) || ''; }
  function pick(txt, key) {
    for (const line of txt.split('\n')) if (line.includes(key)) return line.split(/:(.+)/)[1]?.trim() || '';
    return '';
  }
  function rows(obj) { return Object.entries(obj).map(([k, v]) => `<span class="k">${k}</span><span class="v">${esc(v || '—')}</span>`).join(''); }
  function renderInfo(el, txt) {
    const lines = txt.split('\n').map(s => s.trim()).filter(Boolean);
    const ver = lines.filter(l => !l.includes(':')).slice(0, 2).join(' · ');
    el.innerHTML = rows({
      'Firmware': ver || pick(txt, 'Bruce'),
      'Device': pick(txt, 'Device'),
      'SDK': pick(txt, 'SDK'),
      'MAC address': pick(txt, 'MAC addr'),
      'Wi-Fi': pick(txt, 'Wifi'),
    });
  }
  function renderRes(el, txt) {
    const g = (k) => { const l = txt.split('\n').find(x => x.includes(k)); return l ? +l.replace(/\D/g, '') : 0; };
    const th = g('Total heap'), fh = g('Free heap'), tp = g('Total PSRAM'), fp = g('Free PSRAM');
    const heapPct = th ? Math.round((th - fh) / th * 100) : 0;
    el.innerHTML = rows({
      'Total heap': th ? kb(th) : '—',
      'Free heap': fh ? kb(fh) : '—',
      'PSRAM': tp ? `${kb(tp - fp)} / ${kb(tp)}` : 'Not available',
    }) + `<div class="meter"><i style="width:${heapPct}%"></i></div>`;
    $('#stHeap').textContent = th ? `${heapPct}%` : '—';
  }
  function renderStorage(sdTxt, fsTxt) {
    const parse = (txt) => {
      // first digit-run on each line, as a Number (JS handles the full uint64 range the firmware prints)
      const num = (k) => { const l = txt.split('\n').find(x => x.includes(k)); if (!l) return null; const m = l.match(/(\d+)/); return m ? Number(m[1]) : null; };
      let total = num('Total space'), used = num('Used space'), free = num('Free space');
      if (total == null) return null;
      if (free == null) free = used != null ? total - used : total;
      // guard against the FS layer reporting used > total (would underflow) or a bogus free
      if (free < 0 || free > total) free = Math.max(0, total - (used || 0));
      if (free > total) free = total;
      return { total, free };
    };
    // my_bruce format: free / total in MB (2 decimals)
    const mb2 = (b) => (Number(b) / 1048576).toFixed(2);
    const show = (info) => info ? `${mb2(info.free)} / ${mb2(info.total)} MB` : 'N/A';
    const sdEl = $('#stSd'), fsEl = $('#stFs');
    const sdNone = /not|E\]|No SD/i.test(sdTxt);
    const sd = sdNone ? null : parse(sdTxt);
    sdEl.textContent = sdNone ? 'None' : show(sd);
    sdEl.className = 'value ' + (sdNone || !sd ? 'bad' : 'good');
    const fs = parse(fsTxt);
    fsEl.textContent = show(fs);
    fsEl.className = 'value ' + (fs ? 'good' : 'bad');
  }
  const kb = (b) => (b / 1024).toFixed(0) + ' KB';
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  $('#btnRefreshDash').addEventListener('click', loadDashboard);

  /* ================= REMOTE SCREEN ================= */
  renderer = null;
  function ensureRenderer() { if (!renderer) renderer = new ScreenRenderer($('#navCanvas')); return renderer; }
  /* Size the canvas to a compact, crisp integer scale that fits the frame. */
  function fitCanvas() {
    const c = $('#navCanvas');
    const dw = (renderer && renderer.devW) || Math.round(c.width / 4);
    const dh = (renderer && renderer.devH) || Math.round(c.height / 4);
    if (!dw || !dh) return;
    // Display box; the backing store is RENDER_SCALE x larger, so the browser
    // downsamples it for a crisp HD result (fractional display scale is fine).
    const maxW = 740, maxH = 380;
    let s = Math.min(maxW / dw, maxH / dh);
    s = Math.min(s, 4);                 // don't display beyond the 4x backing (keep it crisp)
    c.style.width = Math.round(dw * s) + 'px';
    c.style.height = Math.round(dh * s) + 'px';
  }
  S.subPacket(pkt => { if (screenStreaming) { ensureRenderer().render(pkt); fitCanvas(); } });

  async function startScreen() {
    if (!S.connected) { toast('Connect first', 'err'); return; }
    ensureRenderer();
    screenStreaming = true;
    $('#panel-screen').classList.add('is-live');   // reveals the D-pad + toolbar
    $('#btnScreenStart').style.display = 'none';
    $('#btnScreenStop').style.display = '';
    $('#screenLive').style.display = '';
    const empty = $('#screenEmpty'); if (empty) empty.style.display = 'none';
    $('#navCanvas').style.display = 'block';
    await S.writeLine('display start');
    await sleep(250);
    // 'display start' streams every draw from now on, but NOT the current frame —
    // so nudge the UI (net-zero move) to force a full redraw that streams it.
    // We deliberately avoid 'display dump': on some devices (e.g. T-Embed) it reads
    // invalid memory and crashes/reboots the firmware. The live stream is enough.
    await nudgeRedraw();
  }
  async function stopScreen() {
    if (!screenStreaming) return;
    screenStreaming = false;
    $('#panel-screen').classList.remove('is-live');   // hides the D-pad + toolbar
    $('#btnScreenStart').style.display = '';
    $('#btnScreenStop').style.display = 'none';
    $('#screenLive').style.display = 'none';
    const empty = $('#screenEmpty'); if (empty) empty.style.display = '';
    $('#navCanvas').style.display = 'none';
    try { await S.writeLine('display stop'); } catch {}
  }
  // Force the device to redraw its current screen, which streams via 'display start'.
  // Net-zero on a menu (moves the selection down then back up). Safe on every
  // device because it never sends 'display dump' (which crashes some firmwares).
  async function nudgeRedraw() {
    if (!screenStreaming) return;
    await S.nav('next'); await sleep(170);
    await S.nav('prev'); await sleep(170);
  }
  $('#btnScreenStart').addEventListener('click', startScreen);
  $('#btnScreenStop').addEventListener('click', stopScreen);
  $('#btnScreenReload').addEventListener('click', () => { if (screenStreaming) nudgeRedraw(); });
  // hold-to-repeat on the D-pad (like qFlipper's KeypadButton: ~350ms to start, then ~160ms repeat).
  // Only the nav press is sent — the live stream repaints; a 'display dump' here would trigger the
  // firmware's backToMenu() and drop out of any running app/keyboard.
  function bindHold(btn, fn) {
    let lt = null, rt = null;
    const stop = () => { clearTimeout(lt); clearInterval(rt); lt = rt = null; };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); lt = setTimeout(() => { rt = setInterval(fn, 160); }, 350); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
  }
  $$('#panel-screen [data-nav]').forEach(b => bindHold(b, () => {
    if (!screenStreaming) { toast('Start the mirror first', 'err'); return; }
    S.nav(b.dataset.nav);   // the live stream repaints; no 'display dump' (it crashes some firmwares)
  }));
  $('#btnSaveShot').addEventListener('click', () => {
    const c = $('#navCanvas');
    try { const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'bruce-screen.png'; a.click(); toast('Screenshot saved', 'ok'); }
    catch { toast('Nothing to save yet', 'err'); }
  });
  // keyboard control when screen panel active
  window.addEventListener('keydown', async (e) => {
    if (!$('#panel-screen').classList.contains('active') || !screenStreaming) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'prev', ArrowRight: 'next', Enter: 'sel', Backspace: 'esc', PageUp: 'prevpage', PageDown: 'nextpage' };
    const dir = map[e.key];
    if (dir) { e.preventDefault(); await S.nav(dir); }   // live stream repaints
  });

  /* ================= FILE MANAGER ================= */
  const FM = (() => {
    let cwd = '/';
    const list = $('#fmList'), crumb = $('#fmCrumb');

    async function ls(path) {
      if (!S.connected) { toast('Connect first', 'err'); return; }
      cwd = normalize(path);
      list.innerHTML = '<div class="empty"><span class="spinner"></span> listing…</div>';
      renderCrumb();
      const txt = await S.sendCommand('ls ' + q(cwd), { silence: 600, timeout: 8000 });
      const entries = parseLs(txt);
      renderList(entries);
    }
    function parseLs(txt) {
      const out = [];
      for (const raw of txt.split('\n')) {
        const line = raw.replace(/\r/, '');
        if (!line.trim() || line.startsWith('COMMAND') || line.startsWith('#') || line.startsWith('[CLI]')) continue;
        const tab = line.indexOf('\t');
        if (tab === -1) continue;
        const name = line.slice(0, tab).trim();
        const rest = line.slice(tab + 1).trim();
        if (!name) continue;
        if (/<DIR>/i.test(rest)) out.push({ name, dir: true });
        else out.push({ name, dir: false, size: +rest || 0 });
      }
      out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      return out;
    }
    function renderList(entries) {
      if (!entries.length) { list.innerHTML = '<div class="empty">' + (cwd === '/' ? 'Empty, or storage not mounted.' : 'Empty folder.') + '</div>'; return; }
      list.innerHTML = entries.map(tile).join('');
      $$('.tile', list).forEach(r => {
        const name = r.dataset.name, isDir = r.dataset.dir === '1';
        if (isDir) r.addEventListener('click', (ev) => { if (ev.target.closest('.tacts')) return; ls(join(cwd, name)); });
        $$('button[data-act]', r).forEach(btn => btn.addEventListener('click', (ev) => { ev.stopPropagation(); fileAction(btn.dataset.act, name, isDir); }));
      });
    }
    function tile(e) {
      const icon = e.dir ? ICON.folder : ICON.file;
      const isJs = !e.dir && /\.js$/i.test(e.name);
      const acts = `<div class="tacts">
        ${isJs ? `<button class="run" data-act="run" title="Run on device">${ICON.play}</button>` : ''}
        ${e.dir ? '' : `<button data-act="view" title="View">${ICON.eye}</button><button data-act="download" title="Download">${ICON.dl}</button>`}
        <button data-act="rename" title="Rename">${ICON.pen}</button>
        <button class="del" data-act="delete" title="Delete">${ICON.trash}</button></div>`;
      return `<div class="tile ${e.dir ? 'dir' : ''}" data-name="${esc(e.name)}" data-dir="${e.dir ? 1 : 0}">
        ${acts}<div class="ticon">${icon}</div><div class="tname">${esc(e.name)}</div>${e.dir ? '' : `<div class="tsize">${human(e.size)}</div>`}</div>`;
    }
    function renderCrumb() {
      const parts = cwd.split('/').filter(Boolean);
      let acc = '';
      let html = `<span class="seg" data-p="/">root</span>`;
      for (const p of parts) { acc += '/' + p; html += `<span class="sep">/</span><span class="seg" data-p="${acc}">${esc(p)}</span>`; }
      crumb.innerHTML = html;
      $$('.seg', crumb).forEach(s => s.addEventListener('click', () => ls(s.dataset.p)));
    }
    async function fileAction(act, name, isDir) {
      const path = join(cwd, name);
      if (act === 'delete') {
        if (!(await uiConfirm(`Delete ${isDir ? 'folder' : 'file'} "${name}"?`, 'Delete', true))) return;
        const cmd = isDir ? 'storage rmdir ' + q(path) : 'rm ' + q(path);
        const r = await S.sendCommand(cmd, { silence: 500 });
        toast(/removed/i.test(r) ? 'Deleted' : 'Delete: ' + oneLine(r), /removed/i.test(r) ? 'ok' : 'err');
        ls(cwd);
      } else if (act === 'rename') {
        const nn = await uiPrompt('New name:', name, 'Rename'); if (!nn) return;
        // the firmware treats newName as a full path (bare names land in /), so keep it in this folder
        const r = await S.sendCommand(`storage rename ${q(path)} ${q(join(cwd, nn))}`, { silence: 500 });
        toast(oneLine(r) || 'Renamed', 'ok'); ls(cwd);
      } else if (act === 'view') {
        const txt = await S.sendCommand('cat ' + q(path), { silence: 700, timeout: 10000 });
        showViewer(name, stripNoise(txt));
      } else if (act === 'download') {
        const txt = await S.sendCommand('cat ' + q(path), { silence: 700, timeout: 15000 });
        const blob = new Blob([stripNoise(txt)], { type: 'application/octet-stream' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
        toast('Downloaded ' + name, 'ok');
      } else if (act === 'run') {
        if (screenStreaming) await stopScreen();
        await S.writeLine('js run_from_file ' + q(path));
        toast('Running ' + name + ' on device', 'ok');
      }
    }
    async function upload(file) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const path = join(cwd, file.name);
      const isText = /\.(txt|js|json|csv|ir|sub|md|log|conf|ndef|rfid|bruce)$/i.test(file.name) && buf.length < 60000;
      toast('Uploading ' + file.name + '…');
      try {
        if (isText) {
          const text = new TextDecoder().decode(buf);
          await S.sendCommand(`storage write ${q(path)} ${buf.length}`, { silence: 400, timeout: 3000 });
          for (const line of text.split('\n')) await S._write(line + '\n');
          await S._write('EOF\n');
          await sleep(400);
          toast('Uploaded ' + file.name, 'ok');
        } else {
          await S.sendYmodem(path, buf, (done, total) => { $('#devChipText').innerHTML = `Upload ${Math.round(done/total*100)}%`; });
          toast('Uploaded ' + file.name + ' (YMODEM)', 'ok');
        }
      } catch (e) { toast('Upload failed: ' + e.message, 'err', 5000); }
      ls(cwd);
    }

    $('#btnFmRefresh').addEventListener('click', () => ls(cwd));
    $('#btnFmBack').addEventListener('click', () => ls(parent(cwd)));
    $('#btnFmMkdir').addEventListener('click', async () => {
      const name = await uiPrompt('New folder name:', '', 'New folder'); if (!name) return;
      const r = await S.sendCommand('storage mkdir ' + q(join(cwd, name)), { silence: 500 });
      toast(oneLine(r) || 'Created', 'ok'); ls(cwd);
    });
    $('#btnFmUp').addEventListener('click', () => $('#fmFileInput').click());
    $('#fmFileInput').addEventListener('change', e => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ''; });

    return { ls, cwd: () => cwd };
  })();

  function showViewer(name, text) {
    const w = window.open('', '_blank');
    if (w) { w.document.title = name; w.document.body.style.cssText = 'background:#0b0b10;color:#eee;font:13px/1.6 monospace;padding:20px;white-space:pre-wrap;word-break:break-word'; w.document.body.textContent = text; }
    else uiAlert(text.slice(0, 4000), name);
  }

  /* ================= APP STORE =================
   * Data from the official Bruce App-Store (brucedevices.github.io/App-Store-Data).
   * Apps are filtered for the connected device (auto-detected), and installed by
   * downloading each file from GitHub raw and pushing it to the device via YModem
   * into the correct folder (/BruceJS/<Category>/ or /Themes/<App>/). */
  const STORE_APPS_URL = 'https://brucedevices.github.io/App-Store-Data/releases/category-all.json';
  const STORE_DEVS_URL = 'https://brucedevices.github.io/App-Store-Data/supported-devices-new.json';
  let storeLoaded = false, storeAllApps = [], storeCatNames = [], storeDevicesRaw = [], storeScreen = {}, storeView = [];
  let selStoreDevice = 'All Devices', selStoreCat = 'All', storeSearchQ = '';

  function matchStoreDevice(detected) {
    if (!detected) return 'All Devices';
    const d = detected.toLowerCase().trim();
    let hit = storeDevicesRaw.find(x => x.name.toLowerCase() === d);
    if (hit) return hit.name;
    hit = storeDevicesRaw.find(x => d.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(d));
    return hit ? hit.name : 'All Devices';
  }
  function storeCompat(app, deviceName, screenSize) {
    if (deviceName === 'All Devices') return true;
    if (app.category === 'Themes') {
      const ass = app['supported-screen-size'];
      if (ass && screenSize !== 'any') {
        const norm = s => String(s).replace('×', 'x').toLowerCase();
        if (norm(ass) !== norm(screenSize)) return false;
      }
    }
    const sd = app['supported-devices'];
    if (!sd) return true;
    if (typeof sd === 'string') {
      try { return new RegExp(sd, 'i').test(deviceName); } catch { return sd.toLowerCase() === deviceName.toLowerCase(); }
    }
    if (Array.isArray(sd)) return sd.some(x => String(x).toLowerCase() === deviceName.toLowerCase());
    return false;
  }

  async function loadStore(force) {
    if (storeLoaded && !force) { renderStore(); return; }
    const msg = $('#storeMsg'); $('#storeTools').style.display = 'none'; $('#storeGrid').innerHTML = '';
    msg.style.display = ''; msg.innerHTML = '<span class="spinner"></span>&nbsp; Loading the Bruce App Store...';
    try {
      const [cr, dr] = await Promise.all([
        fetch(STORE_APPS_URL, { signal: AbortSignal.timeout(15000) }),
        fetch(STORE_DEVS_URL, { signal: AbortSignal.timeout(15000) }),
      ]);
      if (!cr.ok || !dr.ok) throw new Error('bad response');
      const data = await cr.json(); const devs = await dr.json();
      storeAllApps = data.categories.flatMap(c => c.apps || []);
      storeCatNames = [...new Set(data.categories.map(c => c.name))];
      storeDevicesRaw = devs;
      storeScreen = {}; devs.forEach(x => storeScreen[x.name] = x['screen-size']);
      storeLoaded = true;
      selStoreDevice = matchStoreDevice(detectedDeviceName);
      selStoreCat = 'All'; storeSearchQ = ''; $('#storeSearch').value = '';
      $('#storeDevice').innerHTML = ['All Devices', ...devs.map(x => x.name)]
        .map(n => `<option ${n === selStoreDevice ? 'selected' : ''}>${esc(n)}</option>`).join('');
      msg.style.display = 'none';
      renderStore();
    } catch (e) {
      $('#storeTools').style.display = 'none'; $('#storeGrid').innerHTML = '';
      msg.style.display = '';
      msg.innerHTML = '<div style="font-size:16px;color:var(--amber);margin-bottom:8px">NO INTERNET CONNECTION</div>'
        + '<div>The Bruce App Store needs internet to list and download apps.<br>Check your connection and try again.</div>'
        + '<button class="btn sm" id="storeRetry" style="margin-top:16px">RETRY</button>';
      const rb = $('#storeRetry'); if (rb) rb.addEventListener('click', () => loadStore(true));
    }
  }

  function renderStore() {
    if (!storeLoaded) return;
    $('#storeTools').style.display = '';
    const screenSize = selStoreDevice === 'All Devices' ? 'any' : (storeScreen[selStoreDevice] || 'any');
    const compat = storeAllApps.filter(a => storeCompat(a, selStoreDevice, screenSize));
    const cats = ['All', ...storeCatNames];
    $('#storeCats').innerHTML = cats.map(c => {
      const n = c === 'All' ? compat.length : compat.filter(a => a.category === c).length;
      return `<div class="cat-pill ${c === selStoreCat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} <span class="cc">${n}</span></div>`;
    }).join('');
    $$('#storeCats .cat-pill').forEach(p => p.addEventListener('click', () => { selStoreCat = p.dataset.cat; renderStore(); }));

    let apps = compat;
    if (selStoreCat !== 'All') apps = apps.filter(a => a.category === selStoreCat);
    const q = storeSearchQ.toLowerCase().trim();
    if (q) apps = apps.filter(a => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q) || (a.owner || '').toLowerCase().includes(q));
    apps = apps.slice().sort((a, b) => a.name.localeCompare(b.name));
    storeView = apps;
    if (!apps.length) { $('#storeGrid').innerHTML = '<div class="empty">No apps match this filter.</div>'; return; }
    $('#storeGrid').innerHTML = apps.map((a, i) => `
      <div class="store-card">
        <div class="sc-top"><div class="sc-name">${esc(a.name)}</div><span class="sc-cat">${esc(a.category)}</span></div>
        <div class="sc-desc">${esc(a.description || '')}</div>
        <div class="sc-foot"><span class="sc-meta">v${esc(a.version || '?')} · ${esc(a.owner || '')}</span><div class="sc-btns"><button class="btn sm" data-zip="${i}" title="Download .zip to this PC">ZIP</button><button class="btn sm primary" data-install="${i}">INSTALL</button></div></div>
      </div>`).join('');
    $$('#storeGrid [data-install]').forEach(b => b.addEventListener('click', () => installStoreApp(storeView[+b.dataset.install])));
    $$('#storeGrid [data-zip]').forEach(b => b.addEventListener('click', () => downloadStoreApp(storeView[+b.dataset.zip])));
  }

  function buildAppFiles(app) {
    const base = `https://raw.githubusercontent.com/${app.owner}/${app.repo}/${app.commit}`;
    const cleanPath = app.path ? app.path.replace(/^\/+|\/+$/g, '') : '';
    return (app.files || []).map(f => {
      let cleanFile, fileName;
      if (typeof f === 'string') { cleanFile = f.replace(/^\/+/, ''); fileName = f.split('/').pop() || f; }
      else { cleanFile = f.source.replace(/^\/+/, ''); fileName = f.destination || f.source.split('/').pop() || f.source; }
      const url = cleanPath ? `${base}/${cleanPath}/${cleanFile}` : `${base}/${cleanFile}`;
      const dest = app.category === 'Themes' ? `/Themes/${app.name}/${fileName}` : `/BruceJS/${app.category}/${fileName}`;
      return { url, dest, fileName };
    });
  }
  /* download the app's files to this PC — a single file directly, or a .zip for multi-file apps */
  async function downloadStoreApp(app) {
    const files = buildAppFiles(app);
    if (!files.length) { toast('This app has no files listed', 'err'); return; }
    toast('Downloading ' + app.name + '...');
    try {
      if (files.length === 1) {
        const r = await fetch(files[0].url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error('could not download ' + files[0].fileName);
        saveBlob(await r.blob(), files[0].fileName);
      } else {
        if (typeof JSZip === 'undefined') { toast('Zip library not available', 'err'); return; }
        const zip = new JSZip();
        for (const f of files) {
          const r = await fetch(f.url, { signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error('could not download ' + f.fileName);
          zip.file(f.fileName, await r.arrayBuffer());
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        saveBlob(blob, `${app.name.replace(/[^a-zA-Z0-9]/g, '_')}_v${app.version || '1'}.zip`);
      }
      toast('Downloaded ' + app.name, 'ok');
    } catch (e) { toast('Download failed: ' + (e.message || e), 'err', 5000); }
  }
  function saveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function ensureDirs(destPath) {
    const parts = destPath.split('/').filter(Boolean); parts.pop(); // drop filename
    let cur = '';
    for (const p of parts) { cur += '/' + p; await S.sendCommand(`storage mkdir ${q(cur)}`, { silence: 350, timeout: 3000 }); }
  }
  async function installStoreApp(app) {
    if (!S.connected) { toast('Connect the device first', 'err'); return; }
    if (screenStreaming) await stopScreen();
    const files = buildAppFiles(app);
    if (!files.length) { toast('This app has no files listed', 'err'); return; }
    const ov = $('#installOverlay'); ov.style.display = '';
    $('#installTitle').textContent = 'Installing ' + app.name;
    $('#installClose').style.display = 'none';
    const setMsg = m => $('#installMsg').textContent = m;
    const setBar = p => { const v = Math.max(0, Math.min(100, Math.round(p))); $('#installBar').style.width = v + '%'; $('#installPct').textContent = v + '%'; $('#installPctDark').textContent = v + '%'; };
    setBar(0); setMsg('Preparing...');
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i], tag = `(${i + 1}/${files.length})`;
        setMsg(`Creating folders ${tag}`); await ensureDirs(f.dest);
        setMsg(`Downloading ${f.fileName} ${tag}`);
        const r = await fetch(f.url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error('could not download ' + f.fileName);
        const bytes = new Uint8Array(await r.arrayBuffer());
        setMsg(`Uploading ${f.fileName} ${tag}`);
        const base = (i / files.length) * 100, span = 100 / files.length;
        await S.sendYmodem(f.dest, bytes, (done, total) => setBar(base + (total ? done / total : 0) * span));
        setBar(((i + 1) / files.length) * 100);
      }
      const where = app.category === 'Themes' ? `/Themes/${app.name}` : `/BruceJS/${app.category}`;
      setMsg('Installed to ' + where);
      $('#installClose').style.display = ''; toast('Installed ' + app.name, 'ok');
    } catch (e) {
      setMsg('Error: ' + (e.message || e)); $('#installClose').style.display = ''; toast('Install failed', 'err', 5000);
    }
  }
  $('#storeDevice').addEventListener('change', e => { selStoreDevice = e.target.value; renderStore(); });
  $('#btnStoreRefresh').addEventListener('click', () => loadStore(true));
  $('#storeSearch').addEventListener('input', e => { storeSearchQ = e.target.value; renderStore(); });
  $('#installClose').addEventListener('click', () => { $('#installOverlay').style.display = 'none'; });
  let storeInit = false;
  $$('.nav-item').forEach(it => it.addEventListener('click', () => { if (it.dataset.panel === 'store' && !storeInit) { storeInit = true; loadStore(); } }));

  /* ================= UPDATE CHECK =================
   * On launch, ask GitHub for the latest qBruce release and offer the download
   * when it's newer than this build. Silent on any failure (offline, rate limit). */
  const RELEASES_API = 'https://api.github.com/repos/vnxdtzip/qbruce/releases/latest';
  const RELEASES_PAGE = 'https://github.com/vnxdtzip/qbruce/releases/latest';
  function versionParts(v) { return String(v).trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0); }
  function isNewer(latest, current) {
    const a = versionParts(latest), b = versionParts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return false;
  }
  async function checkForUpdate() {
    const current = (window.appInfo && window.appInfo.version) || $('#appVersion').textContent;
    let rel;
    try {
      const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      rel = await r.json();
    } catch { return; }
    if (!rel || !rel.tag_name || !isNewer(rel.tag_name, current)) return;
    while ($('#uiDialog').style.display !== 'none') await sleep(1000);   // don't hijack a dialog the user is in
    const go = await uiDialog({
      title: 'Update available',
      message: `qBruce v${versionParts(rel.tag_name).join('.')} is out (you have v${versionParts(current).join('.')}). Download the new version from GitHub?`,
      okText: 'DOWNLOAD', cancelText: 'LATER',
    });
    if (go) window.open(rel.html_url || RELEASES_PAGE, '_blank');   // Electron hands this to the default browser
  }
  setTimeout(checkForUpdate, 1500);

  /* ================= helpers ================= */
  // SimpleCLI splits arguments on spaces, so quote every path (escaping \ and ")
  // or "DTMF Tones.js" reaches the firmware as two arguments.
  function q(p) { return '"' + String(p).replace(/[\\"]/g, '\\$&') + '"'; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function oneLine(s) { return (s || '').split('\n').map(x => x.trim()).filter(Boolean).pop() || ''; }
  function stripNoise(txt) {
    return txt.split('\n').filter(l => { const t = l.trim(); return !(t.startsWith('COMMAND:') || t.startsWith('[CLI] Result:') || t === '#'); }).join('\n').replace(/\n#\s*$/, '').trim();
  }
  function normalize(p) { p = ('/' + p).replace(/\/+/g, '/'); return p.length > 1 ? p.replace(/\/$/, '') : '/'; }
  function join(base, name) { return normalize(base + '/' + name); }
  function parent(p) { return normalize(p.split('/').slice(0, -1).join('/') || '/'); }
  function human(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }

  // auto list root the first time the Files tab is opened
  let fmInit = false;
  $$('.nav-item').forEach(it => it.addEventListener('click', () => {
    if (it.dataset.panel === 'files' && !fmInit && S.connected) { fmInit = true; FM.ls('/'); }
  }));
})();
