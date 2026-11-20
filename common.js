/* ケアタイム勤怠 共通スクリプト（staff.html / admin.html の両方で使用） */
'use strict';

const IS_RECOVERY = /type=recovery/.test(location.hash);
const CFG = window.CARETIME_CONFIG || {};
const CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_KEY && !/YOUR-/.test(CFG.SUPABASE_URL + CFG.SUPABASE_KEY));
const sb = CONFIGURED && window.supabase ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY) : null;

/* ---------- 小さな道具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const WD = '日月火水木金土';
const dk = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const at = (date, t) => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return dk(new Date(y, m - 1, d + n).getTime()); };
const fmtDate = k => { const [y, m, d] = k.split('-').map(Number); return `${m}/${d}(${WD[new Date(y, m - 1, d).getDay()]})`; };
const hhmm = min => { min = Math.round(min || 0); return `${Math.floor(min / 60)}:${pad(min % 60)}`; };
const yen = n => '¥' + Math.round(n || 0).toLocaleString('ja-JP');
const today = () => dk(Date.now());
const t5 = t => String(t || '').slice(0, 5);          // "09:00:00" → "09:00"
const monthRange = m => { const [y, mo] = m.split('-').map(Number); return [`${m}-01`, dk(new Date(y, mo, 0).getTime())]; };
const CATS = ['食事', '水分', '排泄', '入浴', '服薬', 'バイタル', '睡眠', '様子', '申し送り'];
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

/* DB の行 → 画面で使う形 */
const normRecord = r => ({ id: r.id, staffId: r.staff_id, userId: r.user_id, date: r.work_date, inAt: Date.parse(r.in_at), outAt: r.out_at ? Date.parse(r.out_at) : null, breakMin: r.break_min || 0, edited: r.edited_by_admin,
  visit: r.visit || '', service: r.service || '', accompany: !!r.accompany, inMemo: r.in_memo || '', outMemo: r.out_memo || '' });
const visitLabel = r => (r.visit ? esc(r.visit) : '<span class="muted">訪問先なし</span>') + (r.accompany ? ' <span class="pill info">同行</span>' : '');
const normShift = s => ({ id: s.id, staffId: s.staff_id, date: s.work_date, start: t5(s.start_time), end: t5(s.end_time), memo: s.memo || '', visit: s.visit || '', seriesId: s.series_id || null });
/* スタッフの色（明るい画面・暗い画面のどちらでも読める濃さ） */
const STAFF_COLORS = [
  ['赤', '#d93b3b'], ['青', '#2f6fdb'], ['緑', '#23963f'], ['オレンジ', '#e0700f'], ['紫', '#8d4fd8'],
  ['ピンク', '#d8418c'], ['水色', '#1497b3'], ['茶', '#9a6634'], ['黄緑', '#6f9a12'], ['グレー', '#7b8580'],
];
/* ---------- 日本の祝日（祝日法のルールから計算。2027年以降も自動） ---------- */
const _holidayCache = {};
function jpHolidays(y) {
  if (_holidayCache[y]) return _holidayCache[y];
  const h = new Map(), k = (m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const nthMonday = (m, n) => { const first = new Date(y, m - 1, 1).getDay(); return 1 + ((8 - first) % 7) + (n - 1) * 7; };
  const fixed = [[1, 1, '元日'], [2, 11, '建国記念の日'], [2, 23, '天皇誕生日'], [4, 29, '昭和の日'], [5, 3, '憲法記念日'], [5, 4, 'みどりの日'], [5, 5, 'こどもの日'], [8, 11, '山の日'], [11, 3, '文化の日'], [11, 23, '勤労感謝の日']];
  fixed.forEach(([m, d, n]) => h.set(k(m, d), n));
  h.set(k(1, nthMonday(1, 2)), '成人の日'); h.set(k(7, nthMonday(7, 3)), '海の日');
  h.set(k(9, nthMonday(9, 3)), '敬老の日'); h.set(k(10, nthMonday(10, 2)), 'スポーツの日');
  const e = y - 1980, leap = Math.floor(e / 4);
  h.set(k(3, Math.floor(20.8431 + 0.242194 * e - leap)), '春分の日');
  h.set(k(9, Math.floor(23.2488 + 0.242194 * e - leap)), '秋分の日');
  /* 国民の休日：前後が祝日にはさまれた平日 */
  for (let d = new Date(y, 0, 2); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
    const key = dk(d.getTime());
    if (!h.has(key) && d.getDay() !== 0 && h.has(addDays(key, -1)) && h.has(addDays(key, 1))) h.set(key, '国民の休日');
  }
  /* 振替休日：日曜の祝日のあと、最初の祝日でない日 */
  [...h.keys()].sort().forEach(key => {
    const [yy, mm, dd] = key.split('-').map(Number);
    if (new Date(yy, mm - 1, dd).getDay() !== 0) return;
    let n = addDays(key, 1); while (h.has(n)) n = addDays(n, 1);
    if (n.startsWith(String(y))) h.set(n, '振替休日');
  });
  return (_holidayCache[y] = h);
}
/* メールアドレスがないスタッフ用：ログインIDは「ID@この名前」のメールとして保存（サーバーの関数と同じ値） */
const ID_DOMAIN = 'id.example.com';
const isIdLogin = email => String(email || '').endsWith('@' + ID_DOMAIN);
const loginLabel = email => (isIdLogin(email) ? 'ID ' + email.split('@')[0] : (email || ''));
const holidayName = key => jpHolidays(Number(key.slice(0, 4))).get(key) || '';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];   // 表示順（日曜はじまり）
const jsDay = i => i;                              // WEEK の位置 → Date#getDay()

/* ---------- 計算 ---------- */
function shiftSpan(s) { const a = at(s.date, s.start); let b = at(s.date, s.end); if (b <= a) b += 864e5; return [a, b]; }
/* 夜間（割増）の時間帯と重なる分数。開始＞終了なら日をまたぐ（例 20:00〜翌8:00） */
function nightOverlap(a, b, cfg) {
  const ns = (cfg && cfg.night_start) || '22:00', ne = (cfg && cfg.night_end) || '05:00';
  if (ns === ne) return 0;
  const cross = ne <= ns;
  let t = 0, d = addDays(dk(a), -1); const end = dk(b);
  while (d <= end) {
    const s = at(d, ns), e = at(cross ? addDays(d, 1) : d, ne);
    t += Math.max(0, Math.min(b, e) - Math.max(a, s)); d = addDays(d, 1);
  }
  return t / 6e4;
}
const nightLabel = cfg => `${(cfg && cfg.night_start) || '22:00'}〜${((cfg && cfg.night_end) || '05:00') <= ((cfg && cfg.night_start) || '22:00') ? '翌' : ''}${(cfg && cfg.night_end) || '05:00'}`;
/* 1件の勤務 → 実働・深夜・残業（分） */
function calc(r, cfg) {
  if (!r.outAt) return null;
  const span = (r.outAt - r.inAt) / 6e4;
  const work = Math.max(0, Math.round(span - (r.breakMin || 0)));
  const night = span > 0 ? Math.round(nightOverlap(r.inAt, r.outAt, cfg) * work / span) : 0;
  const ot = Math.max(0, work - Math.round(((cfg && cfg.ot_hours) || 8) * 60));
  return { work, night, ot };
}
const suggestBreak = min => (min > 480 ? 60 : min > 360 ? 45 : 0);
/* 1人分の勤務一覧 → 合計（残業は1日の実働合計が所定時間を超えた分） */
function summarize(recs, cfg) {
  let work = 0, night = 0, open = 0; const perDay = {};
  recs.forEach(r => { const x = calc(r, cfg); if (!x) { open++; return; } work += x.work; night += x.night; perDay[r.date] = (perDay[r.date] || 0) + x.work; });
  const limit = Math.round(((cfg && cfg.ot_hours) || 8) * 60);
  const ot = Object.values(perDay).reduce((a, m) => a + Math.max(0, m - limit), 0);
  return { work, night, ot, open, days: Object.keys(perDay).length, visits: recs.length - open };
}
function spanFrom(date, inT, outT) { const a = at(date, inT); let b = outT ? at(date, outT) : null; if (b !== null && b <= a) b += 864e5; return [a, b]; }

/* ---------- 通知・確認 ---------- */
function toast(msg, kind) { const d = document.createElement('div'); d.textContent = msg; if (kind) d.className = kind; $('#toast').append(d); setTimeout(() => d.remove(), 3600); }
function errText(e) {
  const m = (e && (e.message || e.error_description)) || '';
  if (/Invalid login credentials/i.test(m)) return 'メールアドレスかパスワードが違います';
  if (/Email not confirmed/i.test(m)) return 'メールの確認がまだです。届いたメールのリンクを開いてください';
  if (/already registered/i.test(m)) return 'このメールアドレスはすでに登録されています。ログインしてください';
  if (/Password should be/i.test(m)) return 'パスワードは8文字以上にしてください';
  if (/Signups not allowed|signup_disabled/i.test(m)) return 'いまは新しいアカウント登録が止められています。管理者に連絡してください';
  if (/rate limit|only request this after/i.test(m)) return 'メールの送信回数が上限に達しました。しばらく（1時間ほど）待ってからもう一度お試しください';
  if (/row-level security|permission denied/i.test(m)) return '権限がありません。管理者に確認してください';
  if (/Failed to fetch|NetworkError/i.test(m)) return '通信できませんでした。電波の良い場所でもう一度お試しください';
  if (/[ぁ-んァ-ン一-龥]/.test(m)) return m;   // サーバー側で日本語にしたメッセージはそのまま
  return '処理できませんでした（' + (m || '不明なエラー') + '）';
}
/* Supabase の呼び出しを包む：失敗時はトースト */
async function run(promise, okMsg) {
  try {
    const { data, error } = await promise;
    if (error) throw error;
    if (okMsg) toast(okMsg);
    return { ok: true, data };
  } catch (e) { console.error(e); toast(errText(e), 'bad'); return { ok: false }; }
}
function armDelete(btn, fn, label) {
  if (btn.classList.contains('armed')) { fn(); return; }
  const t = btn.textContent; btn.classList.add('armed'); btn.textContent = label || 'もう一度押すと削除';
  setTimeout(() => { btn.classList.remove('armed'); btn.textContent = t; }, 5000);
}
/* 変更画面（モーダル）の中に「本当に削除しますか？」を出す。保存ボタンは隠す */
function confirmInModal(message, onYes) {
  const old = $('#m-confirm'); if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'm-confirm'; box.className = 'banner bad stack'; box.style.margin = '0'; box.style.gap = '10px';
  box.innerHTML = `<strong>${esc(message)}</strong><div class="row"><button type="button" class="btn" id="m-confirm-yes" style="background:var(--bad);border-color:var(--bad);color:var(--surface)">削除する</button><button type="button" class="btn" id="m-confirm-no">やめる</button></div>`;
  $('#m-body').append(box); $('#m-ok').hidden = true;
  box.scrollIntoView({ block: 'nearest' });
  $('#m-confirm-no').addEventListener('click', () => { box.remove(); $('#m-ok').hidden = false; });
  $('#m-confirm-yes').addEventListener('click', async e => { e.currentTarget.disabled = true; await onYes(); });
}
function fillSelect(el, opts, placeholder) {
  const html = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') + opts.map(o => `<option value="${esc(o.v)}"${o.disabled ? ' disabled' : ''}>${esc(o.t)}</option>`).join('');
  if (el.dataset.sig === html) return;   // 中身が同じなら作り直さない（入力中・選択中を邪魔しない）
  const v = el.value;
  el.dataset.sig = html;
  el.innerHTML = html;
  if ([...el.options].some(o => o.value === v)) el.value = v;
}
function setupTabs(sel, key, onPick) {
  const root = $(sel), panels = root.parentElement.querySelectorAll(':scope > [data-panel]');
  const pick = t => { root.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t))); panels.forEach(p => { p.hidden = p.dataset.panel !== t; }); ls.set(key, t); if (onPick) onPick(t); };
  root.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) pick(b.dataset.tab); });
  const saved = ls.get(key); if (saved && root.querySelector(`[data-tab="${saved}"]`)) pick(saved);
}

/* ---------- モーダル ---------- */
let modalSubmit = null;
function openModal(title, body, okText, onSubmit) {
  $('#m-title').textContent = title; $('#m-body').innerHTML = body; $('#m-ok').textContent = okText || '保存'; $('#m-ok').hidden = false; $('#m-ok').style.cssText = '';
  modalSubmit = onSubmit; $('#modal').hidden = false;
  const f = $('#m-body').querySelector('input,select,textarea'); if (f) f.focus();
}
function closeModal() { $('#modal').hidden = true; modalSubmit = null; $('#m-ok').hidden = false; }
function timeForm(v, visits) {
  const vs = visits ? `<label class="f">訪問先<select name="visit" required><option value="">選んでください</option>${[...new Set([...(visits || []), ...(v.visit ? [v.visit] : [])])].map(x => `<option value="${esc(x)}"${x === v.visit ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
  <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="accompany" value="1" style="width:auto"${v.accompany ? ' checked' : ''}> 同行</label>` : '';
  return vs + `<label class="f">日付<input type="date" name="date" required value="${esc(v.date || today())}"></label>
  <div class="grid2"><label class="f">出勤<input type="time" name="inTime" required value="${esc(v.inTime || '')}"></label>
  <label class="f">退勤<input type="time" name="outTime" value="${esc(v.outTime || '')}"></label></div>
  <label class="f">休憩（分）<input type="number" name="breakMin" min="0" max="600" step="5" value="${esc(v.breakMin ?? 0)}"></label>
  <p class="muted small" style="margin:0">退勤が出勤より早い時刻なら翌日の退勤として扱います。</p>`;
}
document.addEventListener('DOMContentLoaded', () => {
  $('#m-form').addEventListener('submit', async e => {
    e.preventDefault(); if (!modalSubmit) return;
    const btn = $('#m-ok'); btn.disabled = true;
    const ok = await modalSubmit(Object.fromEntries(new FormData(e.target)));
    btn.disabled = false; if (ok) closeModal();
  });
  $('#m-cancel').addEventListener('click', closeModal);
});

/* ---------- ログイン画面 ---------- */
function showAuth(mode, opts) {
  const box = $('#auth'); box.hidden = false; $('#app').hidden = true;
  const titles = { login: 'ログイン', idlogin: 'IDとコードでログイン', signup: 'はじめての方（アカウント登録）', reset: 'パスワードの再設定', newpass: '新しいパスワードを決める' };
  const f = {
    idlogin: `<p class="muted small" style="margin:0">管理者から受け取った「ログインID（4桁）」と「招待コード（6桁）」を入れてください。</p>
            <label class="f">ログインID<input id="au-id" inputmode="numeric" maxlength="8" autocomplete="username" required placeholder="例）1234" style="font-size:22px;letter-spacing:.15em"></label>
            <label class="f">招待コード<input type="password" id="au-pass" inputmode="numeric" maxlength="12" autocomplete="current-password" required placeholder="例）123456" style="font-size:22px;letter-spacing:.15em"></label>
            <button class="btn primary" type="submit" style="padding:14px;font-size:1.1rem">ログイン</button>
            <button class="btn link" type="button" data-mode="login">メールアドレスでログインする方はこちら</button>`,
    login: `<button class="btn" type="button" data-mode="idlogin" style="padding:12px;font-size:1rem;border-color:var(--accent);color:var(--accent)">メールアドレスがない方（IDとコードでログイン）</button>
            <label class="f">メールアドレス<input type="email" id="au-email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" required></label>
            <label class="f">パスワード<input type="password" id="au-pass" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
            <button class="btn primary" type="submit">ログイン</button>
            <div class="row" style="justify-content:space-between">${opts.signup ? '<button class="btn link" type="button" data-mode="signup">はじめての方はこちら</button>' : '<span></span>'}<button class="btn link" type="button" data-mode="reset">パスワードを忘れた</button></div>`,
    signup: `<label class="f">お名前（管理者が確認に使います）<input id="au-name" autocomplete="name" required placeholder="例）山田 花子"></label>
            <label class="f">メールアドレス<input type="email" id="au-email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" required></label>
            <label class="f">パスワード（8文字以上）<input type="password" id="au-pass" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="8" required></label>
            <button class="btn primary" type="submit">登録する</button>
            <button class="btn link" type="button" data-mode="login">アカウントをお持ちの方はログイン</button>`,
    reset: `<p class="muted small" style="margin:0">登録したメールアドレスに、パスワードを決め直すためのリンクを送ります。</p>
            <label class="f">メールアドレス<input type="email" id="au-email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" required></label>
            <button class="btn primary" type="submit">リンクを送る</button>
            <button class="btn link" type="button" data-mode="login">ログインに戻る</button>`,
    newpass: `<label class="f">新しいパスワード（8文字以上）<input type="password" id="au-pass" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="8" required></label>
            <button class="btn primary" type="submit">保存してログイン</button>`,
  };
  box.innerHTML = `<form class="card stack" id="au-form"><div><h2>${titles[mode]}</h2><p class="muted small" style="margin:4px 0 0">${esc(opts.subtitle || '')}</p></div><div id="au-msg"></div>${f[mode]}</form>`;
  box.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => showAuth(b.dataset.mode, opts)));
  const pw = $('#au-pass');
  if (pw) {
    const t = document.createElement('label');
    t.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:.88rem;color:var(--muted);margin-top:-6px';
    t.innerHTML = `<input type="checkbox" id="au-show" style="width:auto"> ${mode === 'idlogin' ? 'コードを表示' : 'パスワードを表示'}`;
    pw.closest('label').after(t);
    $('#au-show').addEventListener('change', e => { pw.type = e.target.checked ? 'text' : 'password'; });
  }
  const msg = (t, bad) => { $('#au-msg').innerHTML = `<div class="banner ${bad ? 'bad' : 'info'}" style="margin:0">${esc(t)}</div>`; };
  $('#au-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
    const email = $('#au-email') && $('#au-email').value.trim().toLowerCase(), pass = $('#au-pass') && $('#au-pass').value;
    const back = location.origin + location.pathname;
    try {
      if (mode === 'login') {
        const { data, error } = await sb.auth.signInWithPassword({ email, password: pass }); if (error) throw error;
        opts.onSession(data.session);
      } else if (mode === 'idlogin') {
        const id = $('#au-id').value.replace(/[^0-9０-９]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
        const code = pass.replace(/[^0-9０-９]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
        const { data, error } = await sb.auth.signInWithPassword({ email: `${id}@${ID_DOMAIN}`, password: code });
        if (error) { if (/Invalid login credentials/i.test(error.message)) { msg('ログインIDか招待コードが違います。もう一度確かめて入れてください', true); btn.disabled = false; return; } throw error; }
        opts.onSession(data.session);
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { name: $('#au-name').value.trim() }, emailRedirectTo: back } });
        if (error) throw error;
        if (data.session) opts.onSession(data.session);
        else msg('確認メールを送りました。メールのリンクを開いてから、このページでログインしてください。');
      } else if (mode === 'reset') {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: back }); if (error) throw error;
        msg('メールを送りました。届いたリンクを開いてください。');
      } else if (mode === 'newpass') {
        const { error } = await sb.auth.updateUser({ password: pass }); if (error) throw error;
        history.replaceState(null, '', location.pathname);
        const { data } = await sb.auth.getSession(); opts.onSession(data.session);
      }
    } catch (err) { console.error(err); msg(errText(err), true); }
    btn.disabled = false;
  });
}
/* 起動：設定チェック → セッション確認 → ログイン画面 or アプリ */
async function bootAuth(opts) {
  if (!CONFIGURED || !sb) {
    $('#auth').hidden = false;
    $('#auth').innerHTML = `<div class="card stack"><h2>まだ接続設定がされていません</h2><p class="muted" style="margin:0">同じフォルダの <code>config.js</code> に Supabase の Project URL と Publishable key を入れてください。手順は README.md にあります。</p></div>`;
    return;
  }
  sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') showAuth('newpass', opts); });
  const { data } = await sb.auth.getSession();
  if (IS_RECOVERY) { showAuth('newpass', opts); return; }
  if (data.session) opts.onSession(data.session); else showAuth('login', opts);
}
async function signOut() { await sb.auth.signOut(); location.reload(); }
