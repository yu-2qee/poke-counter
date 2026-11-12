(function () {
  /* Supabase の URL とキーは js/config.js に書く。空なら端末内だけで動き、通信は一切しない。 */
  var CFG = window.TSUTSUKI_CONFIG || {};
  var SUPABASE_URL = CFG.supabaseUrl || '';
  var SUPABASE_KEY = CFG.supabaseKey || '';
  var HAS_SERVER = !!(SUPABASE_URL && SUPABASE_KEY);
  var api = window.createApi(SUPABASE_URL, SUPABASE_KEY);
  if (!HAS_SERVER) document.body.classList.remove('booting');   /* 共有しない使い方では、ログイン画面なしでそのまま開く */

  function $(id) { return document.getElementById(id); }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  var user = null, dirty = false, applying = false, pushTimer = null, retryTimer = null;
  var SYNC_KEYS = { count: 1, threshold: 1 };
  var MIRROR = { count: 1, threshold: 1, events: 1, ledger: 1, memos: 1 };
  /* localStorage が消されたときに備えて、IndexedDB にも同じデータを控えとして保存する */
  var idb = null;
  function idbOpen(cb) {
    try {
      var r = indexedDB.open('tsutsuki', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { idb = r.result; cb(); };
      r.onerror = function () { cb(); };
    } catch (e) { cb(); }
  }
  function idbPut(k, v) {
    if (!idb) return;
    try { idb.transaction('kv', 'readwrite').objectStore('kv').put(JSON.stringify(v), k); } catch (e) {}
  }
  function idbAll(cb) {
    if (!idb) { cb({}); return; }
    try {
      var o = {}, req = idb.transaction('kv').objectStore('kv').openCursor();
      req.onsuccess = function () { var c = req.result; if (c) { o[c.key] = c.value; c.continue(); } else cb(o); };
      req.onerror = function () { cb({}); };
    } catch (e) { cb({}); }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    if (MIRROR[k]) idbPut(k, v);
    if (user && !applying && SYNC_KEYS[k]) markDirty();
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function yen(n) { return Math.round(n).toLocaleString('ja-JP'); }
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  var now = new Date();

  /* ---------- tabs ---------- */
  var TABS = ['counter', 'calendar', 'budget', 'memo'].concat(HAS_SERVER ? ['album'] : []);
  $('tab-album').hidden = !HAS_SERVER;
  if (HAS_SERVER) $('bkNote').textContent = '読み込んだ予定・家計簿・メモは、共有データに追加されます(同じものは重複しません)。写真はこのバックアップに含まれません。';
  function show(name) {
    if (TABS.indexOf(name) < 0) name = 'counter';
    TABS.forEach(function (t) {
      $('view-' + t).classList.toggle('active', t === name);
      $('tab-' + t).classList.toggle('on', t === name);
    });
    try { history.replaceState(null, '', '#' + name); } catch (e) {}
    window.scrollTo(0, 0);
    if (name === 'calendar') renderCal();
    if (name === 'budget') renderBudget();
    if (name === 'memo') renderMemo();
    if (name === 'album') renderAlbum();
  }
  TABS.forEach(function (t) { $('tab-' + t).addEventListener('click', function () { show(t); }); });

  /* ---------- counter ---------- */
  var count = parseInt(load('count', 0), 10) || 0;
  var threshold = 6, cooling = false, running = false, gotData = false;
  var COOLDOWN_MS = 350, DEG2RAD = Math.PI / 180;
  var saved = parseFloat(load('threshold', 6));
  if (saved >= 2 && saved <= 12) threshold = saved;
  $('th').value = threshold; $('thv').textContent = threshold.toFixed(1);
  $('count').textContent = String(count);

  $('th').addEventListener('input', function () {
    threshold = parseFloat($('th').value);
    $('thv').textContent = threshold.toFixed(1);
    save('threshold', threshold);
  });
  $('reset').addEventListener('click', function () { count = 0; $('count').textContent = '0'; save('count', 0); });

  function poke() {
    count++; cooling = true; save('count', count);
    $('count').textContent = String(count);
    $('count').classList.add('pulse');
    setTimeout(function () { $('count').classList.remove('pulse'); }, 220);
    $('bar').classList.add('cool');
    if (navigator.vibrate) navigator.vibrate(30);
    setTimeout(function () { cooling = false; $('bar').classList.remove('cool'); }, COOLDOWN_MS);
  }
  function onMotion(e) {
    var r = e.rotationRate;
    if (!r || r.alpha == null) return;
    gotData = true;
    var x = (r.beta || 0) * DEG2RAD, y = (r.gamma || 0) * DEG2RAD, z = (r.alpha || 0) * DEG2RAD;
    var mag = Math.sqrt(x * x + y * y + z * z);
    $('mag').textContent = '現在の角速度: ' + mag.toFixed(1) + ' rad/s';
    $('bar').style.width = Math.min(100, (mag / (threshold * 1.5)) * 100) + '%';
    if (mag > threshold && !cooling) poke();
  }
  function begin() {
    window.addEventListener('devicemotion', onMotion);
    running = true; $('start').hidden = true; $('msg').textContent = '';
    setTimeout(function () {
      if (!gotData) $('msg').textContent = 'センサーの値が届きません。HTTPSで開いているか、端末のモーションセンサー設定を確認してください。';
    }, 2500);
  }
  $('start').addEventListener('click', function () {
    if (running) return;
    if (typeof DeviceMotionEvent === 'undefined') { $('msg').textContent = 'このブラウザはモーションセンサーに対応していません。'; return; }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then(function (s) {
        if (s === 'granted') begin();
        else $('msg').textContent = '許可されませんでした。Safariを一度閉じて開き直し、もう一度お試しください。';
      }).catch(function (err) { $('msg').textContent = '許可の取得に失敗しました: ' + err; });
    } else { begin(); }
  });

  /* ---------- calendar ---------- */
  var events = load('events', {});
  var cal = { y: now.getFullYear(), m: now.getMonth(), sel: ymd(now) };

  function renderCal() {
    $('calTitle').textContent = cal.y + '年' + (cal.m + 1) + '月';
    var g = $('calGrid'); g.textContent = '';
    WD.forEach(function (w, i) { g.appendChild(el('div', 'wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), w)); });
    var first = new Date(cal.y, cal.m, 1).getDay();
    var days = new Date(cal.y, cal.m + 1, 0).getDate();
    var today = ymd(now);
    var money = {}; ledger.forEach(function (x) { money[x.date] = 1; });
    for (var i = 0; i < first; i++) g.appendChild(el('div', 'cell empty'));
    for (var d = 1; d <= days; d++) {
      (function (d) {
        var key = cal.y + '-' + pad(cal.m + 1) + '-' + pad(d);
        var dow = (first + d - 1) % 7;
        var b = el('button', 'cell' + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') + (key === today ? ' today' : '') + (key === cal.sel ? ' sel' : ''));
        b.type = 'button';
        b.appendChild(el('span', 'dn', String(d)));
        var dots = el('span', 'dots');
        if (events[key] && events[key].length) dots.appendChild(el('span', 'dot'));
        if (money[key]) dots.appendChild(el('span', 'dot money'));
        b.appendChild(dots);
        b.addEventListener('click', function () { cal.sel = key; renderCal(); });
        g.appendChild(b);
      })(d);
    }
    renderDay();
  }
  function renderDay() {
    var p = cal.sel.split('-');
    var dt = new Date(+p[0], +p[1] - 1, +p[2]);
    $('dayTitle').textContent = (dt.getMonth() + 1) + '月' + dt.getDate() + '日(' + WD[dt.getDay()] + ')の予定';
    var ul = $('dayList'); ul.textContent = '';
    var list = (events[cal.sel] || []).slice().sort(function (a, b) { return (a.time || '') < (b.time || '') ? -1 : 1; });
    renderDayMoney();
    if (!list.length) { ul.appendChild(el('li', 'empty-note', 'この日の予定はありません。')); return; }
    list.forEach(function (ev) {
      var li = el('li');
      li.appendChild(el('span', 'time', ev.time || '終日'));
      var main = el('span', 'main'); main.appendChild(el('div', null, ev.text));
      if (ev.by) main.appendChild(el('div', 'sub', ev.by + ' が追加'));
      li.appendChild(main);
      var del = el('button', 'del', '削除'); del.type = 'button';
      del.addEventListener('click', function () {
        var date = cal.sel;
        mutate('event/delete', { date: date, id: ev.id }, function () {
          events[date] = (events[date] || []).filter(function (x) { return x.id !== ev.id; });
          if (!events[date].length) delete events[date];
          save('events', events);
        }).then(function () { renderCal(); });
      });
      li.appendChild(del); ul.appendChild(li);
    });
  }
  function renderDayMoney() {
    var ul = $('dayLedger'); ul.textContent = '';
    var items = ledger.filter(function (x) { return x.date === cal.sel; });
    var inc = 0, out = 0;
    items.forEach(function (x) { if (x.type === 'in') inc += x.amt; else out += x.amt; });
    var bal = inc - out;
    $('dayMoneySum').textContent = items.length ? '差引 ' + (bal < 0 ? '-' : '') + yen(Math.abs(bal)) + '円' : '';
    if (!items.length) { ul.appendChild(el('li', 'empty-note', 'この日の記録はありません。')); return; }
    items.forEach(function (x) {
      var li = el('li'), main = el('span', 'main');
      main.appendChild(el('div', null, x.cat + (x.memo ? '  ' + x.memo : '')));
      if (x.by) main.appendChild(el('div', 'sub', x.by));
      li.appendChild(main);
      li.appendChild(el('span', 'amt ' + x.type, (x.type === 'in' ? '+' : '-') + yen(x.amt)));
      ul.appendChild(li);
    });
  }
  function moveMonth(o, delta) {
    o.m += delta;
    if (o.m < 0) { o.m = 11; o.y--; } else if (o.m > 11) { o.m = 0; o.y++; }
  }
  $('calPrev').addEventListener('click', function () { moveMonth(cal, -1); renderCal(); });
  $('calNext').addEventListener('click', function () { moveMonth(cal, 1); renderCal(); });
  $('calToday').addEventListener('click', function () { now = new Date(); cal.y = now.getFullYear(); cal.m = now.getMonth(); cal.sel = ymd(now); renderCal(); });
  $('calToBudget').addEventListener('click', function () {
    var p = cal.sel.split('-');
    bm.y = +p[0]; bm.m = +p[1] - 1; $('bdDate').value = cal.sel;
    show('budget'); $('bdAmt').focus();
  });
  $('evText').addEventListener('input', function () { $('evErr').textContent = ''; });
  $('evAdd').addEventListener('click', function () {
    var text = $('evText').value.trim();
    if (!text) { $('evErr').textContent = '予定の内容を入力してください。'; return; }
    var date = cal.sel, ev = { id: uid(), time: $('evTime').value, text: text };
    mutate('event/add', { date: date, id: ev.id, time: ev.time, text: ev.text }, function () {
      (events[date] = events[date] || []).push(ev);
      save('events', events);
    }).then(function (ok) {
      if (!ok) return;
      $('evText').value = ''; $('evTime').value = ''; $('evErr').textContent = '';
      renderCal();
    });
  });

  /* ---------- budget ---------- */
  var CATS = {
    out: ['食費', '日用品', '交通', '住居・光熱', '趣味・娯楽', '医療', 'その他'],
    'in': ['給与', '副収入', 'その他']
  };
  var ledger = load('ledger', []);
  var bm = { y: now.getFullYear(), m: now.getMonth() };

  function fillCats() {
    var sel = $('bdCat'); sel.textContent = '';
    CATS[$('bdType').value].forEach(function (c) { var o = el('option', null, c); o.value = c; sel.appendChild(o); });
  }
  $('bdType').addEventListener('change', fillCats);
  fillCats();
  $('bdDate').value = ymd(now);

  function renderBudget() {
    var prefix = bm.y + '-' + pad(bm.m + 1);
    $('bdTitle').textContent = bm.y + '年' + (bm.m + 1) + '月';
    var items = ledger.filter(function (x) { return x.date.slice(0, 7) === prefix; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    var inc = 0, out = 0, byCat = {};
    items.forEach(function (x) {
      if (x.type === 'in') inc += x.amt; else { out += x.amt; byCat[x.cat] = (byCat[x.cat] || 0) + x.amt; }
    });
    $('sumIn').textContent = yen(inc);
    $('sumOut').textContent = yen(out);
    var bal = inc - out;
    $('sumBal').textContent = (bal < 0 ? '-' : '') + yen(Math.abs(bal));
    $('sumBal').style.color = bal < 0 ? 'var(--exp)' : 'var(--fg)';

    var cats = $('cats'); cats.textContent = '';
    Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; }).forEach(function (c) {
      var wrap = el('div', 'cat'), t = el('div', 't');
      t.appendChild(el('span', null, c)); t.appendChild(el('span', null, yen(byCat[c]) + '円'));
      var b = el('div', 'b'), i = el('i'); i.style.width = Math.max(2, (byCat[c] / out) * 100) + '%';
      b.appendChild(i); wrap.appendChild(t); wrap.appendChild(b); cats.appendChild(wrap);
    });

    var ul = $('bdList'); ul.textContent = '';
    if (!items.length) { ul.appendChild(el('li', 'empty-note', 'この月の記録はありません。下のフォームから追加できます。')); return; }
    items.forEach(function (x) {
      var li = el('li'), main = el('span', 'main');
      main.appendChild(el('div', null, x.cat + (x.memo ? '  ' + x.memo : '')));
      main.appendChild(el('div', 'sub', x.date.slice(5).replace('-', '/') + (x.by ? ' ・' + x.by : '')));
      li.appendChild(main);
      li.appendChild(el('span', 'amt ' + x.type, (x.type === 'in' ? '+' : '-') + yen(x.amt)));
      var del = el('button', 'del', '削除'); del.type = 'button';
      del.addEventListener('click', function () {
        mutate('ledger/delete', { id: x.id }, function () {
          ledger = ledger.filter(function (y) { return y.id !== x.id; });
          save('ledger', ledger);
        }).then(function () { renderBudget(); });
      });
      li.appendChild(del); ul.appendChild(li);
    });
  }
  $('bdPrev').addEventListener('click', function () { moveMonth(bm, -1); renderBudget(); });
  $('bdNext').addEventListener('click', function () { moveMonth(bm, 1); renderBudget(); });
  $('bdAmt').addEventListener('input', function () { $('bdErr').textContent = ''; });
  $('bdAdd').addEventListener('click', function () {
    var date = $('bdDate').value, amt = parseInt($('bdAmt').value, 10);
    if (!date) { $('bdErr').textContent = '日付を選んでください。'; return; }
    if (!(amt > 0)) { $('bdErr').textContent = '金額は1円以上の数字で入力してください。'; return; }
    var entry = { id: uid(), date: date, type: $('bdType').value, cat: $('bdCat').value, amt: amt, memo: $('bdMemo').value.trim() };
    mutate('ledger/add', entry, function () { ledger.push(entry); save('ledger', ledger); }).then(function (ok) {
      if (!ok) return;
      var p = date.split('-'); bm.y = +p[0]; bm.m = +p[1] - 1;
      $('bdAmt').value = ''; $('bdMemo').value = ''; $('bdErr').textContent = '';
      renderBudget();
    });
  });

  /* ---------- backup ---------- */
  $('export').addEventListener('click', function () {
    var data = { version: 1, count: count, threshold: threshold, events: events, ledger: ledger, memos: memos };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'tsutsuki-backup-' + ymd(new Date()) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    $('bkMsg').className = 'ok'; $('bkMsg').textContent = '書き出しました。';
    save('lastBackup', ymd(new Date())); renderBackupInfo();
  });
  $('importBtn').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function () {
    var f = $('importFile').files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (!d || typeof d.events !== 'object' || !Array.isArray(d.ledger)) throw new Error('形式が違います');
        if (typeof d.count === 'number') { count = d.count; $('count').textContent = String(count); save('count', count); }
        var done = function () { $('bkMsg').className = 'ok'; $('bkMsg').textContent = user ? '読み込みました(共有データに追加しました)。' : '読み込みました。'; };
        var im = Array.isArray(d.memos) ? d.memos : [];
        if (user) { mutate('merge', { events: d.events, ledger: d.ledger, memos: im }, null).then(function (ok) { if (ok) done(); }); }
        else { events = d.events; ledger = d.ledger; memos = im; save('events', events); save('ledger', ledger); save('memos', memos); renderCal(); renderBudget(); renderMemo(); done(); }
      } catch (e) {
        $('bkMsg').className = 'err'; $('bkMsg').textContent = '読み込めませんでした。書き出したファイルを選んでください。';
      }
      $('importFile').value = '';
    };
    r.readAsText(f);
  });

  /* ---------- memo ---------- */
  var memos = load('memos', []);
  if (!Array.isArray(memos)) memos = [];
  var editingId = null, delId = null, delTimer = null;
  function fmtTime(ts) {
    var d = new Date(ts || 0);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function resetMemoForm() {
    editingId = null; $('memoIn').value = ''; $('memoErr').textContent = '';
  }
  function renderMemo() {
    $('memoNote').textContent = HAS_SERVER
      ? 'ログイン中は、メモがアカウントの全端末で共有されます。ログインしていない間はこの端末だけに保存されます。'
      : 'メモはこの端末のブラウザ内にだけ保存されます。';
    if (editingId && !memos.some(function (m) { return m.id === editingId; })) editingId = null;
    $('memoSave').textContent = editingId ? '更新する' : 'メモを追加';
    $('memoCancel').hidden = !editingId;
    var ul = $('memoList'); ul.textContent = '';
    var list = memos.slice().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    if (!list.length) { ul.appendChild(el('li', 'empty-note', 'メモはまだありません。上のフォームから追加できます。')); return; }
    list.forEach(function (m) {
      var li = el('li', 'memo'), main = el('span', 'main');
      main.appendChild(el('div', 'memo-text', m.text));
      main.appendChild(el('div', 'sub', fmtTime(m.updated) + (m.by ? ' ・' + m.by : '')));
      li.appendChild(main);
      var btns = el('div', 'memo-btns');
      var ed = el('button', 'del', '編集'); ed.type = 'button';
      ed.addEventListener('click', function () {
        editingId = m.id; $('memoIn').value = m.text; $('memoErr').textContent = '';
        renderMemo(); $('memoIn').focus(); window.scrollTo(0, 0);
      });
      var del = el('button', 'del', delId === m.id ? 'もう一度押すと削除' : '削除'); del.type = 'button';
      del.addEventListener('click', function () {
        if (delId !== m.id) {
          delId = m.id; clearTimeout(delTimer);
          delTimer = setTimeout(function () { delId = null; renderMemo(); }, 3000);
          renderMemo(); return;
        }
        clearTimeout(delTimer); delId = null;
        mutate('memo/delete', { id: m.id }, function () {
          memos = memos.filter(function (x) { return x.id !== m.id; });
          save('memos', memos);
        }).then(function (ok) {
          if (ok && editingId === m.id) resetMemoForm();
          renderMemo();
        });
      });
      btns.appendChild(ed); btns.appendChild(del); li.appendChild(btns); ul.appendChild(li);
    });
  }
  $('memoIn').addEventListener('input', function () { $('memoErr').textContent = ''; });
  $('memoCancel').addEventListener('click', function () { resetMemoForm(); renderMemo(); });
  $('memoSave').addEventListener('click', function () {
    var text = $('memoIn').value.trim();
    if (!text) { $('memoErr').textContent = 'メモの内容を入力してください。'; return; }
    var ts = Date.now(), p;
    if (editingId) {
      var id = editingId;
      p = mutate('memo/update', { id: id, text: text, updated: ts }, function () {
        memos.forEach(function (m) { if (m.id === id) { m.text = text; m.updated = ts; } });
        save('memos', memos);
      });
    } else {
      var m = { id: uid(), text: text, updated: ts };
      p = mutate('memo/add', m, function () { memos.push(m); save('memos', memos); });
    }
    p.then(function (ok) { if (!ok) return; resetMemoForm(); renderMemo(); });
  });

  /* ---------- album ---------- */
  /* 写真は縮小して Supabase Storage に保存し、日付・コメントなどの情報は DB(photos)に保存する。 */
  var photos = [], urlCache = {};              /* urlCache: ファイル名 → { url, exp }(表示用の一時URL) */
  var ALB_PAGE = 60, albShown = ALB_PAGE, albBusy = false;
  var viewId = null, viewNext = null, viewTok = 0, vDelArmed = false, vDelTimer = null;

  function albMsg(text, bad) { var m = $('albMsg'); m.textContent = text || ''; m.className = bad ? 'err' : 'ok'; }
  function albActive() { return $('view-album').classList.contains('active'); }
  function renderAlbumIfOpen() {
    if (!HAS_SERVER) return;
    if (albActive()) renderAlbum();
    if (viewId) refreshViewer(false);
  }
  function cachedUrl(path) { var c = urlCache[path]; return c && c.exp > Date.now() ? c.url : null; }
  function getUrls(paths) {
    var out = {}, need = [];
    paths.forEach(function (p) { var u = cachedUrl(p); if (u) out[p] = u; else need.push(p); });
    if (!need.length) return Promise.resolve(out);
    var chunks = [];
    for (var i = 0; i < need.length; i += 100) chunks.push(need.slice(i, i + 100));
    return Promise.all(chunks.map(function (c) { return api.signed(c); })).then(function (rs) {
      rs.forEach(function (m) {
        Object.keys(m).forEach(function (k) { urlCache[k] = { url: m[k], exp: Date.now() + 50 * 60 * 1000 }; out[k] = m[k]; });
      });
      return out;
    });
  }

  function renderAlbum() {
    var box = $('albGrid'); box.textContent = '';
    if (!photos.length) {
      box.appendChild(el('div', 'empty-note', 'まだ写真がありません。「写真を追加」から選んでください。'));
      $('albMore').hidden = true; return;
    }
    var totals = {}, groups = [], gmap = {}, imgs = [];
    photos.forEach(function (ph) { var k = ph.taken.slice(0, 7); totals[k] = (totals[k] || 0) + 1; });
    photos.slice(0, albShown).forEach(function (ph) {
      var k = ph.taken.slice(0, 7);
      if (!gmap[k]) { gmap[k] = { key: k, items: [] }; groups.push(gmap[k]); }
      gmap[k].items.push(ph);
    });
    groups.forEach(function (g) {
      var sec = el('section');
      sec.appendChild(el('h2', null, g.key.slice(0, 4) + '年' + parseInt(g.key.slice(5), 10) + '月 ・' + totals[g.key] + '枚'));
      var grid = el('div', 'alb-grid');
      g.items.forEach(function (ph) {
        var b = el('button', 'ph' + (ph.caption ? ' cap' : '')); b.type = 'button';
        b.setAttribute('aria-label', (ph.caption || '写真') + '(' + ph.taken + ')');
        var im = el('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async';
        imgs.push({ im: im, path: ph.id + '_t.jpg' });
        b.appendChild(im);
        b.addEventListener('click', function () { openViewer(ph.id); });
        grid.appendChild(b);
      });
      sec.appendChild(grid); box.appendChild(sec);
    });
    $('albMore').hidden = photos.length <= albShown;
    getUrls(imgs.map(function (x) { return x.path; })).then(function (m) {
      imgs.forEach(function (x) { if (m[x.path]) x.im.src = m[x.path]; });
    }).catch(function (e) {
      if (e && e.status === 401) syncError(e); else albMsg('写真を読み込めません。通信を確認してください。', true);
    });
  }
  $('albMore').addEventListener('click', function () { albShown += ALB_PAGE; renderAlbum(); });

  /* --- 追加:縮小して保存 --- */
  function decodeImage(file) {
    function viaImg() {
      return new Promise(function (res, rej) {
        var u = URL.createObjectURL(file), im = new Image();
        im.onload = function () { URL.revokeObjectURL(u); res({ el: im, w: im.naturalWidth, h: im.naturalHeight }); };
        im.onerror = function () { URL.revokeObjectURL(u); var e = new Error('unsupported'); e.code = 'unsupported'; rej(e); };
        im.src = u;
      });
    }
    if (!window.createImageBitmap) return viaImg();
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(function () { return createImageBitmap(file); })
      .then(function (b) { return { el: b, w: b.width, h: b.height, close: function () { if (b.close) b.close(); } }; })
      .catch(viaImg);
  }
  function toJpeg(img, max, q) {
    var k = Math.min(1, max / Math.max(img.w, img.h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.w * k)); c.height = Math.max(1, Math.round(img.h * k));
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img.el, 0, 0, c.width, c.height);
    return new Promise(function (res, rej) {
      c.toBlob(function (b) { if (b) res(b); else rej(new Error('encode')); }, 'image/jpeg', q);
    });
  }
  function addOne(file, i) {
    if (file.size > 60 * 1024 * 1024) { var big = new Error('too_big'); big.code = 'too_big'; return Promise.reject(big); }
    var id = uid() + i.toString(36);
    var taken = file.lastModified ? ymd(new Date(file.lastModified)) : ymd(new Date());
    return decodeImage(file).then(function (img) {
      var done = function () { if (img.close) img.close(); };
      return Promise.all([toJpeg(img, 1600, 0.82), toJpeg(img, 480, 0.75)]).then(function (b) { done(); return b; }, function (e) { done(); throw e; });
    }).then(function (b) {
      return api.upload(id, b[0], b[1]).catch(function (e) { api.removeObjects(id).catch(function () {}); throw e; });
    }).then(function () {
      return mutate('photo/add', { id: id, taken: taken, caption: '' }, null);
    }).then(function (ok) {
      if (!ok) { api.removeObjects(id).catch(function () {}); var e = new Error('sync'); e.code = 'sync'; throw e; }
    });
  }
  function albReason(e) {
    if (!e) return '';
    if (e.code === 'unsupported') return 'この形式の画像は読み込めません(JPEG・PNGなどを選んでください)。';
    if (e.code === 'too_big') return 'ファイルが大きすぎます(60MBまで)。';
    if (e.code === 'sync') return '';
    if (e.status === 413) return 'ファイルが大きすぎます。';
    if (e.status === 404 || e.status === 403) return 'アルバムの準備ができていません。schema-album.sql を実行したか確認してください。';
    return '通信を確認してください。';
  }
  function addPhotos(files) {
    if (albBusy) return;
    var list = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name); });
    if (!list.length) { albMsg('画像ファイルを選んでください。', true); return; }
    albBusy = true; $('albAdd').disabled = true;
    var ok = 0, fail = 0, lastErr = null, chain = Promise.resolve();
    list.forEach(function (f, i) {
      chain = chain.then(function () {
        albMsg(list.length + '枚中 ' + (i + 1) + '枚目を保存しています…');
        return addOne(f, i).then(function () { ok++; }, function (e) { fail++; lastErr = e; });
      });
    });
    chain.then(function () {
      albBusy = false; $('albAdd').disabled = false;
      if (lastErr && lastErr.status === 401) { syncError(lastErr); return; }
      if (!fail) albMsg(ok + '枚追加しました。');
      else albMsg((ok ? ok + '枚追加、' : '') + fail + '枚は保存できませんでした。' + albReason(lastErr), true);
    });
  }
  $('albAdd').addEventListener('click', function () { $('albFile').click(); });
  $('albFile').addEventListener('change', function () { var f = $('albFile').files; if (f && f.length) addPhotos(f); $('albFile').value = ''; });

  /* --- 拡大表示・編集・削除 --- */
  function photoIndex(id) { for (var i = 0; i < photos.length; i++) if (photos[i].id === id) return i; return -1; }
  function resetDelBtn() { vDelArmed = false; clearTimeout(vDelTimer); $('vDel').textContent = '削除'; }
  function openViewer(id) {
    viewId = id; $('viewer').hidden = false; document.body.style.overflow = 'hidden';
    try { history.pushState({ v: 1 }, '', location.href); } catch (e) {}
    refreshViewer(true);
    $('vClose').focus();
  }
  function closeViewer(fromPop) {
    if (!viewId) return;
    viewId = null; viewNext = null; viewTok++; resetDelBtn();
    $('viewer').hidden = true; document.body.style.overflow = ''; $('vImg').removeAttribute('src'); $('vErr').textContent = '';
    if (!fromPop) { try { if (history.state && history.state.v) history.back(); } catch (e) {} }
  }
  function refreshViewer(fresh) {
    var i = photoIndex(viewId);
    if (i < 0) {                                  /* 削除された(自分または他の端末で) */
      if (viewNext && photoIndex(viewNext) >= 0) { viewId = viewNext; viewNext = null; refreshViewer(true); }
      else closeViewer();
      return;
    }
    var ph = photos[i];
    $('vPos').textContent = (i + 1) + ' / ' + photos.length;
    $('vPrev').disabled = i === 0; $('vNext').disabled = i === photos.length - 1;
    if (!fresh) return;
    resetDelBtn();
    $('vDate').value = ph.taken; $('vCap').value = ph.caption || ''; $('vBy').textContent = ph.by || '—'; $('vErr').textContent = '';
    var tok = ++viewTok, img = $('vImg'), t = cachedUrl(ph.id + '_t.jpg');
    if (t) img.src = t; else img.removeAttribute('src');
    getUrls([ph.id + '.jpg']).then(function (m) {
      var u = m[ph.id + '.jpg'];
      if (!u || tok !== viewTok) return;
      var pre = new Image();
      pre.onload = function () { if (tok === viewTok) img.src = u; };
      pre.src = u;
    }).catch(function () { if (tok === viewTok) $('vErr').textContent = '写真を読み込めません。通信を確認してください。'; });
  }
  function stepViewer(d) {
    var i = photoIndex(viewId) + d;
    if (i < 0 || i >= photos.length) return;
    viewId = photos[i].id; refreshViewer(true);
  }
  $('vClose').addEventListener('click', function () { closeViewer(); });
  $('vPrev').addEventListener('click', function () { stepViewer(-1); });
  $('vNext').addEventListener('click', function () { stepViewer(1); });
  window.addEventListener('popstate', function () { if (viewId) closeViewer(true); });
  document.addEventListener('keydown', function (e) {
    if (!viewId) return;
    if (e.key === 'Escape') closeViewer();
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !/^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || '')) stepViewer(e.key === 'ArrowLeft' ? -1 : 1);
  });
  (function () {
    var x0 = 0, y0 = 0, st = $('vStage');
    st.addEventListener('touchstart', function (e) { var t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    st.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepViewer(dx < 0 ? 1 : -1);
    }, { passive: true });
  })();
  $('vSave').addEventListener('click', function () {
    var i = photoIndex(viewId); if (i < 0) return;
    var date = $('vDate').value;
    if (!date) { $('vErr').textContent = '日付を選んでください。'; return; }
    mutate('photo/update', { id: viewId, taken: date, caption: $('vCap').value.trim() }, null).then(function (ok) {
      if (ok) { $('vErr').textContent = ''; toast('保存しました。'); }
    });
  });
  $('vDel').addEventListener('click', function () {
    if (!viewId) return;
    if (!vDelArmed) { vDelArmed = true; $('vDel').textContent = 'もう一度押すと削除'; vDelTimer = setTimeout(resetDelBtn, 3000); return; }
    resetDelBtn();
    var i = photoIndex(viewId), id = viewId;
    viewNext = i >= 0 && photos[i + 1] ? photos[i + 1].id : (i > 0 ? photos[i - 1].id : null);
    mutate('photo/delete', { id: id }, null).then(function (ok) { viewNext = null; if (!ok) $('vErr').textContent = '削除できませんでした。'; });
  });

  /* ---------- account / sync ---------- */
  var ERRORS = {
    bad_credentials: 'メールアドレスかパスワードが違います。',
    limited: '失敗が続いたため、しばらく待ってからやり直してください。',
    server: 'サーバーが混み合っています。しばらくしてからやり直してください。'
  };
  function acMsg(text, bad) {
    var t = $(user ? 'acOutMsg' : 'acMsg');
    t.textContent = text || ''; t.className = bad ? 'err' : 'ok';
  }
  function setSync(text, bad) {
    var s = $('syncMsg'); s.hidden = !text; s.textContent = text || ''; s.className = 'sync' + (bad ? ' bad' : '');
  }
  function renderAcct() {
    if (!HAS_SERVER) return;
    $('acctBox').hidden = !user;
    document.body.classList.remove('booting');
    document.body.classList.toggle('gated', !user);   /* ログインしていない間は、ログイン画面だけを出す */
    if (user) { $('acName').textContent = user; setSync('同期済み'); }
    else { setSync(''); closeViewer(); }
  }
  function hasLocalData() { return count > 0 || ledger.length > 0 || memos.length > 0 || Object.keys(events).length > 0; }
  var toastTimer = null;
  function toast(text) {
    var t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function syncError(e) {
    if (e && e.status === 401) { user = null; renderAcct(); acMsg('ログインの期限が切れました。もう一度ログインしてください。', true); toast('ログインの期限が切れました。'); return; }
    var msg = (e && e.code === 'too_many') ? '登録できる件数の上限に達しました。' : '同期できません。通信を確認してください。';
    setSync(msg, true); toast(msg);
  }
  function applyShared(sh) {
    applying = true;
    events = (sh && sh.events) || {}; save('events', events);
    ledger = (sh && sh.ledger) || []; save('ledger', ledger);
    memos = (sh && sh.memos) || []; save('memos', memos);
    photos = (sh && sh.photos) || [];   /* 写真の一覧はこの端末には保存しない(見るたびに最新を取る) */
    applying = false;
    renderCal(); renderBudget(); renderMemo(); renderAlbumIfOpen();
    if (!dirty) setSync('同期済み');
  }
  function mutate(action, payload, local) {
    if (!user) { if (local) local(); return Promise.resolve(true); }
    return api('POST', '/api/shared/' + action, payload).then(function (r) { applyShared(r.shared); return true; })
      .catch(function (e) { syncError(e); return false; });
  }

  function markDirty() {
    dirty = true; setSync('保存待ち…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 1500);
  }
  function push() {
    clearTimeout(pushTimer); clearTimeout(retryTimer);
    if (!user || !dirty) return Promise.resolve(true);
    dirty = false; setSync('保存中…');
    return api('PUT', '/api/personal', { count: count, threshold: threshold }).then(function () {
      if (!dirty) setSync('同期済み');
      return true;
    }).catch(function (e) {
      if (e.status === 401) { syncError(e); return false; }
      dirty = true; setSync('同期できません。通信が戻ると再送します。', true);
      retryTimer = setTimeout(push, 15000);
      return false;
    });
  }
  function pull(firstLogin) {
    return api('GET', '/api/data').then(function (r) {
      var p = r.personal || {};
      applying = true;
      var keepLocalCount = firstLogin && count > 0 && !(p.count > 0);
      if (!keepLocalCount) { count = Number(p.count) || 0; $('count').textContent = String(count); save('count', count); }
      var t = Number(p.threshold);
      if (t >= 2 && t <= 12) { threshold = t; $('th').value = t; $('thv').textContent = t.toFixed(1); save('threshold', t); }
      applying = false;
      if (keepLocalCount) markDirty();
      if (firstLogin && (ledger.length > 0 || memos.length > 0 || Object.keys(events).length > 0)) {
        save('localBackup', { count: count, events: events, ledger: ledger, memos: memos });
        return mutate('merge', { events: events, ledger: ledger, memos: memos }, null);
      }
      applyShared(r.shared);
    }).catch(function (e) { if (e.status === 401) { user = null; renderAcct(); } else { setSync('同期できません。通信を確認してください。', true); } });
  }
  function refresh() {
    if (!user || dirty || document.visibilityState !== 'visible') return;
    api('GET', '/api/data').then(function (r) { applyShared(r.shared); }).catch(function () {});
  }
  function clearLocal() {
    applying = true;
    count = 0; $('count').textContent = '0'; save('count', 0);
    events = {}; save('events', events);
    ledger = []; save('ledger', ledger);
    memos = []; save('memos', memos);
    photos = []; urlCache = {};
    applying = false;
    renderCal(); renderBudget(); renderMemo(); renderAlbumIfOpen();
  }
  function auth(kind) {
    var u = $('acU').value.trim().toLowerCase(), p = $('acP').value;
    if (!u || !p) { acMsg('メールアドレスとパスワードを入力してください。', true); return; }
    var body = { username: u, password: p };
    acMsg('');
    api('POST', '/api/' + kind, body).then(function (r) {
      user = r.username; $('acP').value = '';
      renderAcct(); acMsg(''); return pull(true);
    }).catch(function (e) { acMsg(ERRORS[e.code] || '通信に失敗しました。もう一度お試しください。', true); });
  }
  $('loginForm').addEventListener('submit', function (e) { e.preventDefault(); auth('login'); });
  $('acLogout').addEventListener('click', function () {
    push().then(function (ok) {
      if (!ok) { acMsg('同期できないため、ログアウトできません。通信を確認してください。', true); return; }
      return api('POST', '/api/logout', {}).then(function () { user = null; $('acP').value = ''; clearLocal(); renderAcct(); acMsg(''); });
    });
  });
  document.addEventListener('visibilitychange', function () {
    refresh();
  });
  setInterval(refresh, 30000);
  if (HAS_SERVER) {
    api('GET', '/api/me').then(function (r) {
      user = r.username; renderAcct(); return pull(false);
    }).catch(function () { renderAcct(); });   /* 保存されたログインがなければ、ログイン画面を出す */
  }

  /* ---------- persistence ---------- */
  function renderBackupInfo() {
    var lb = load('lastBackup', null);
    $('bkLast').textContent = lb ? '最終バックアップ: ' + lb
      : (hasLocalData() ? 'まだバックアップしていません。ときどき「書き出す」で保存しておくと安心です。' : '');
  }
  function mirrorAll() {
    idbPut('count', count); idbPut('threshold', threshold);
    idbPut('events', events); idbPut('ledger', ledger); idbPut('memos', memos);
  }
  function localEmpty() {
    try { return ['count', 'events', 'ledger', 'memos'].every(function (k) { return localStorage.getItem(k) === null; }); }
    catch (e) { return false; }
  }
  function restoreFromIdb() {
    idbAll(function (o) {
      function g(k) { try { return o[k] != null ? JSON.parse(o[k]) : undefined; } catch (e) { return undefined; } }
      var c = g('count'), t = g('threshold'), ev = g('events'), lg = g('ledger'), mm = g('memos'), any = false;
      applying = true;
      if (typeof c === 'number' && c > 0) { count = c; $('count').textContent = String(c); save('count', c); any = true; }
      if (t >= 2 && t <= 12) { threshold = t; $('th').value = t; $('thv').textContent = t.toFixed(1); save('threshold', t); }
      if (ev && typeof ev === 'object' && !Array.isArray(ev) && Object.keys(ev).length) { events = ev; save('events', events); any = true; }
      if (Array.isArray(lg) && lg.length) { ledger = lg; save('ledger', ledger); any = true; }
      if (Array.isArray(mm) && mm.length) { memos = mm; save('memos', memos); any = true; }
      applying = false;
      if (any) { renderCal(); renderBudget(); renderMemo(); toast('ブラウザ側のデータが消えていたため、控えから復元しました。'); }
      renderBackupInfo(); mirrorAll();
    });
  }
  idbOpen(function () { if (localEmpty()) restoreFromIdb(); else mirrorAll(); });
  renderBackupInfo();
  (function () {
    var k = $('keepMsg');
    if (!(navigator.storage && navigator.storage.persist)) { k.textContent = 'データは端末内に自動で二重保存されます。'; return; }
    var show2 = function (ok) {
      k.textContent = ok ? 'ブラウザにデータの永続保存を許可されています(自動で消されにくい状態)。'
        : 'データは端末内に二重保存されています。ホーム画面に追加して使うと、さらに消えにくくなります。';
    };
    navigator.storage.persisted().then(function (p) { return p ? true : navigator.storage.persist(); }).then(show2).catch(function () { show2(false); });
  })();

  show((location.hash || '').slice(1));
  /* ---------- アプリ化(オフラインでも開けるようにする) ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
