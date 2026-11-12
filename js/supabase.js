/* Supabase(ログインとデータ保存)への通信。画面側からは api(メソッド, パス, 中身) で呼ぶ。
   url と key が空なら、通信せずにエラーを返す(端末内だけで動くモード)。 */
(function () {
  'use strict';
  window.createApi = function (SUPABASE_URL, SUPABASE_KEY) {
    var HAS_SERVER = !!(SUPABASE_URL && SUPABASE_KEY);
    function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  var SB_URL = SUPABASE_URL.replace(/\/+$/, '');
  var sbSess = load('sbSession', null);
  var sbRefreshing = null;
  function apiErr(status, code) { var e = new Error(code || ('HTTP ' + status)); e.status = status; e.code = code; return e; }
  function nameOf(email) { return String(email || '').split('@')[0]; }
  function sbSave(s) {
    sbSess = s;
    try { if (s) localStorage.setItem('sbSession', JSON.stringify(s)); else localStorage.removeItem('sbSession'); } catch (e) {}
  }
  function sbToSess(j) {
    var prev = sbSess || {};
    return {
      access: j.access_token, refresh: j.refresh_token || prev.refresh,
      exp: Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
      uid: (j.user && j.user.id) || prev.uid, email: (j.user && j.user.email) || prev.email
    };
  }
  function sbRaw(path, opt, tok) {
    opt = opt || {};
    var h = Object.assign({ apikey: SUPABASE_KEY }, opt.headers || {});
    if (tok) h.Authorization = 'Bearer ' + tok;
    if (opt.body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(SB_URL + path, { method: opt.method || 'GET', headers: h, body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined });
  }
  function sbRefresh() {
    if (!sbSess || !sbSess.refresh) return Promise.reject(apiErr(401, 'unauthorized'));
    if (sbRefreshing) return sbRefreshing;
    sbRefreshing = sbRaw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: sbSess.refresh } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.access_token) {
            if (r.status >= 400 && r.status < 500) sbSave(null);   // 期限切れ・無効 → ログインし直し
            throw apiErr(r.status >= 500 ? r.status : 401, 'unauthorized');
          }
          sbSave(sbToSess(j)); return sbSess;
        });
      })
      .then(function (s) { sbRefreshing = null; return s; }, function (e) { sbRefreshing = null; throw e; });
    return sbRefreshing;
  }
  function sbToken() {
    if (!sbSess) return Promise.reject(apiErr(401, 'unauthorized'));
    if (sbSess.exp - 60 > Date.now() / 1000) return Promise.resolve(sbSess.access);
    return sbRefresh().then(function (s) { return s.access; });
  }
  function sbRest(path, opt, retried) {
    return sbToken().then(function (t) { return sbRaw('/rest/v1' + path, opt, t); }).then(function (r) {
      if (r.status === 401) {
        if (retried) throw apiErr(401, 'unauthorized');
        if (sbSess) sbSess.exp = 0;
        return sbRest(path, opt, true);
      }
      return r.text().then(function (txt) {
        var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!r.ok) throw apiErr(r.status, (j && (j.code || j.message)) || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function sbAll(table, select, order) {
    var out = [];
    function page(off) {
      return sbRest('/' + table + '?select=' + select + '&order=' + order + '&limit=1000&offset=' + off).then(function (rows) {
        rows = rows || []; out = out.concat(rows);
        return rows.length === 1000 ? page(off + 1000) : out;
      });
    }
    return page(0);
  }
  function sbShared() {
    return Promise.all([
      sbAll('events', 'id,date,time,text,author', 'date.asc,time.asc,created.asc,id.asc'),
      sbAll('ledger', 'id,date,type,cat,amt,memo,author', 'date.asc,created.asc,id.asc'),
      sbAll('memos', 'id,text,updated,author', 'updated.desc,id.asc'),
      sbAll('photos', 'id,caption,taken,author', 'taken.desc,created.desc,id.asc').catch(function (e) {
        if (e && (e.status === 404 || e.code === 'PGRST205' || e.code === '42P01')) return [];   /* schema-album.sql をまだ実行していない */
        throw e;
      })
    ]).then(function (r) {
      var ev = {};
      r[0].forEach(function (e) { (ev[e.date] = ev[e.date] || []).push({ id: e.id, time: e.time, text: e.text, by: e.author }); });
      return {
        events: ev,
        ledger: r[1].map(function (x) { return { id: x.id, date: x.date, type: x.type, cat: x.cat, amt: x.amt, memo: x.memo, by: x.author }; }),
        memos: r[2].map(function (m) { return { id: m.id, text: m.text, updated: Number(m.updated), by: m.author }; }),
        photos: r[3].map(function (x) { return { id: x.id, caption: x.caption, taken: x.taken, by: x.author }; })
      };
    });
  }
  var SB_IGN = { Prefer: 'resolution=ignore-duplicates,missing=default,return=minimal' };
  function sbInsert(table, rows) {
    var p = Promise.resolve();
    for (var i = 0; i < rows.length; i += 500) (function (chunk) {
      p = p.then(function () { return sbRest('/' + table + '?on_conflict=id', { method: 'POST', headers: SB_IGN, body: chunk }); });
    })(rows.slice(i, i + 500));
    return p;
  }
  var sbReId = /^[a-z0-9]{1,24}$/, sbReDate = /^\d{4}-\d{2}-\d{2}$/, sbReTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  function sbOkEvent(d, e) { return e && sbReId.test(String(e.id)) && sbReDate.test(String(d)) && typeof e.text === 'string' && e.text.trim().length >= 1 && e.text.length <= 80 && (!e.time || sbReTime.test(e.time)); }
  function sbOkLedger(x) { return x && sbReId.test(String(x.id)) && sbReDate.test(String(x.date)) && (x.type === 'in' || x.type === 'out') && typeof x.cat === 'string' && x.cat.length >= 1 && x.cat.length <= 20 && Number.isInteger(x.amt) && x.amt >= 1 && x.amt <= 1e9 && (x.memo == null || (typeof x.memo === 'string' && x.memo.length <= 40)); }
  function sbOkMemo(m) { return m && sbReId.test(String(m.id)) && typeof m.text === 'string' && m.text.trim().length >= 1 && m.text.length <= 2000; }
  var SB_MIN = { Prefer: 'return=minimal' };
  function sbWrite(action, b) {
    var id = encodeURIComponent(String(b.id));
    switch (action) {
      case 'event/add': return sbInsert('events', [{ id: b.id, date: b.date, time: b.time || '', text: b.text }]);
      case 'event/delete': return sbRest('/events?id=eq.' + id, { method: 'DELETE', headers: SB_MIN });
      case 'ledger/add': return sbInsert('ledger', [{ id: b.id, date: b.date, type: b.type, cat: b.cat, amt: b.amt, memo: b.memo || '' }]);
      case 'ledger/delete': return sbRest('/ledger?id=eq.' + id, { method: 'DELETE', headers: SB_MIN });
      case 'memo/add': return sbInsert('memos', [{ id: b.id, text: b.text, updated: b.updated }]);
      case 'memo/update': return sbRest('/memos?id=eq.' + id, { method: 'PATCH', headers: SB_MIN, body: { text: b.text, updated: b.updated } });
      case 'memo/delete': return sbRest('/memos?id=eq.' + id, { method: 'DELETE', headers: SB_MIN });
      case 'photo/add':
        if (!sbReDate.test(String(b.taken))) return Promise.reject(apiErr(400, 'bad_request'));
        return sbInsert('photos', [{ id: b.id, taken: b.taken, caption: String(b.caption || '').slice(0, 100) }]);
      case 'photo/update':
        if (!sbReDate.test(String(b.taken))) return Promise.reject(apiErr(400, 'bad_request'));
        return sbRest('/photos?id=eq.' + id, { method: 'PATCH', headers: SB_MIN, body: { caption: String(b.caption || '').slice(0, 100), taken: b.taken } });
      case 'photo/delete':
        return sbRest('/photos?id=eq.' + id, { method: 'DELETE', headers: SB_MIN }).then(function () { return sbRemoveObjects(b.id).catch(function () {}); });
      case 'merge': {
        var evs = [], lgs = [], mms = [];
        var be = (b.events && typeof b.events === 'object') ? b.events : {};
        Object.keys(be).forEach(function (d) {
          (Array.isArray(be[d]) ? be[d] : []).forEach(function (e) { if (sbOkEvent(d, e)) evs.push({ id: e.id, date: d, time: e.time || '', text: e.text }); });
        });
        (Array.isArray(b.ledger) ? b.ledger : []).forEach(function (x) { if (sbOkLedger(x)) lgs.push({ id: x.id, date: x.date, type: x.type, cat: x.cat, amt: x.amt, memo: x.memo || '' }); });
        (Array.isArray(b.memos) ? b.memos : []).forEach(function (m) { if (sbOkMemo(m)) mms.push({ id: m.id, text: m.text, updated: Math.floor(Number(m.updated)) || Date.now() }); });
        return sbInsert('events', evs).then(function () { return sbInsert('ledger', lgs); }).then(function () { return sbInsert('memos', mms); });
      }
    }
    return Promise.reject(apiErr(404, 'not_found'));
  }
  /* ---- 写真ファイル(Supabase Storage の非公開バケット "album") ---- */
  function sbPutObject(path, blob) {
    return sbToken().then(function (t) {
      return fetch(SB_URL + '/storage/v1/object/album/' + path, {
        method: 'POST', body: blob,
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' }
      });
    }).then(function (r) {
      if (r.ok) return;
      return r.json().catch(function () { return {}; }).then(function (j) { throw apiErr(r.status, j.error || j.message || ('HTTP ' + r.status)); });
    });
  }
  function sbRemoveObjects(id) {
    return sbToken().then(function (t) {
      return sbRaw('/storage/v1/object/album', { method: 'DELETE', body: { prefixes: [id + '.jpg', id + '_t.jpg'] } }, t);
    }).then(function (r) { if (!r.ok) throw apiErr(r.status, 'remove_failed'); });
  }
  /* 表示用の一時URL(1時間)。paths は "ID.jpg" や "ID_t.jpg"。結果は { path: url } */
  function sbSigned(paths) {
    return sbToken().then(function (t) {
      return sbRaw('/storage/v1/object/sign/album', { method: 'POST', body: { expiresIn: 3600, paths: paths } }, t);
    }).then(function (r) {
      return r.json().catch(function () { return []; }).then(function (j) {
        if (!r.ok || !Array.isArray(j)) throw apiErr(r.status, 'sign_failed');
        var out = {};
        j.forEach(function (x) { if (x && x.signedURL && !x.error) out[x.path] = SB_URL + '/storage/v1' + x.signedURL; });
        return out;
      });
    });
  }
  function sbLogin(b) {
    return sbRaw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: b.username, password: b.password } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.access_token) throw apiErr(r.status, r.status === 429 ? 'limited' : r.status >= 500 ? 'server' : 'bad_credentials');
        sbSave(sbToSess(j)); return { username: nameOf(sbSess.email) };
      });
    });
  }
  function sbLogout() {
    var t = sbSess && sbSess.access;
    sbSave(null);
    return (t ? sbRaw('/auth/v1/logout', { method: 'POST' }, t).catch(function () {}) : Promise.resolve()).then(function () { return { ok: true }; });
  }
  /* 画面側からは、これまで通り api(メソッド, パス, 中身) で呼ぶ。中身はSupabaseへの通信に置き換える。 */
  function api(method, url, body) {
    body = body || {};
    if (!HAS_SERVER) return Promise.reject(apiErr(0, 'no_server'));
    var m = method + ' ' + url;
    if (m === 'POST /api/login') return sbLogin(body);
    if (m === 'POST /api/signup') return Promise.reject(apiErr(400, 'signup_closed'));
    if (m === 'POST /api/logout') return sbLogout();
    if (m === 'GET /api/me') return sbSess ? Promise.resolve({ username: nameOf(sbSess.email) }) : Promise.reject(apiErr(401, 'unauthorized'));
    if (m === 'GET /api/data') {
      return sbToken().then(function () {
        return Promise.all([
          sbRest('/personal?select=count,threshold&user_id=eq.' + encodeURIComponent(sbSess.uid)).then(function (rows) { return (rows && rows[0]) || {}; }),
          sbShared()
        ]);
      }).then(function (r) { return { personal: r[0], shared: r[1] }; });
    }
    if (m === 'PUT /api/personal') {
      return sbToken().then(function () {
        return sbRest('/personal?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: { user_id: sbSess.uid, count: body.count, threshold: body.threshold } });
      }).then(function () { return { ok: true }; });
    }
    if (url.indexOf('/api/shared/') === 0) {
      return sbWrite(url.slice(12), body).then(sbShared).then(function (sh) { return { shared: sh }; });
    }
    return Promise.reject(apiErr(404, 'not_found'));
  }
    api.upload = function (id, full, thumb) { return sbPutObject(id + '.jpg', full).then(function () { return sbPutObject(id + '_t.jpg', thumb); }); };
    api.removeObjects = sbRemoveObjects;
    api.signed = sbSigned;
    return api;
  };
})();
