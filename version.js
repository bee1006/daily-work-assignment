// 全站統一版本管理、Microsoft/Email 登入、RBAC 權限與 Supabase 團隊雲端同步核心
(function () {
  window.APP_VERSION = "V3.1";
  const ADMIN_EMAIL = "u971503@taipower.com.tw";
  const ADMIN_EMAILS = ["u971503@taipower.com.tw", "bee1006@gmail.com"];
  const GUEST_EMAIL = "guest@taipower.local";

  function normalizeAuthEmail(input) {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw) return "";
    return raw.includes("@") ? raw : `${raw}@taipower.local`;
  }

  function formatUserDisplay(email) {
    const lower = String(email || "").trim().toLowerCase();
    if (!lower) return "";
    if (lower === GUEST_EMAIL) return "guest（助理專用）";
    if (lower.endsWith("@taipower.local")) return lower.slice(0, -"@taipower.local".length);
    return email;
  }
  const CONTRACT_ORDER = [
    "蘆竹區配電線路設備維護暨事故搶修工作",
    "龜山區配電線路設備維護暨事故搶修工作",
    "桃園區配電線路設備維護暨事故搶修工作",
    "八德區配電線路設備維護暨事故搶修工作",
    "乙工區配電線路設備維護暨事故搶修工作",
    "大園區配電線路設備維護暨事故搶修工作",
    "中壢區配電線路設備維護暨事故搶修工作",
    "觀音區配電線路設備維護暨事故搶修工作",
    "丁工區配電線路設備維護暨事故搶修工作",
    "變壓器現場停電檢測工作",
    "甲工區人手孔加固維護工作",
    "乙工區人手孔加固維護工作",
    "丙工區人手孔加固維護工作",
    "自動化開關設備檢點維護工作",
    "甲工區人手孔及配電場所設備檢點維護工作",
    "乙工區人手孔及配電場所設備檢點維護工作",
    "設備油漆及美化工作",
    "人手孔及配電場所防水維護",
    "電桿牌裝設暨桿上設備檢點維護工作"
  ];

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rocDate = d => {
    if (!d || !d.includes("-")) return d || "";
    const [y, m, day] = d.split("-").map(Number);
    return `${y - 1911}/${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  };
  const contractRank = name => {
    const idx = CONTRACT_ORDER.findIndex(k => String(name || "").includes(k));
    return idx < 0 ? CONTRACT_ORDER.length : idx;
  };
  const workCategory = name => {
    const rank = contractRank(name);
    return rank < 10 ? "A" : rank < 13 ? "B" : "C";
  };

  function buildDailyWorkItemsFromPayload(payload, fallbackRoster) {
    const jobs = payload?.jobs || [];
    const assignments = payload?.assignments || {};
    const roster = (payload?.roster && payload.roster.length) ? payload.roster : (fallbackRoster || []);
    const groups = new Map();
    for (const job of jobs) {
      const key = `${job.contract}|||${job.crew}`;
      if (!groups.has(key)) groups.set(key, { contract: job.contract, crew: job.crew, jobs: [] });
      groups.get(key).jobs.push(job);
    }
    const teams = [...groups.values()].sort((a, b) => contractRank(a.contract) - contractRank(b.contract) || a.crew.localeCompare(b.crew, "zh-Hant"));
    return teams.map((team, idx) => {
      const key = `${team.contract}|||${team.crew}`;
      const saved = assignments[key] || {};
      const staff = roster.find(p => p.id === saved.staffId) || null;
      return {
        order: idx + 1,
        category: workCategory(team.contract),
        contract: team.contract,
        crew: team.crew,
        staffId: staff ? staff.id : (saved.staffId || null),
        staffName: staff ? staff.name : null,
        manual: !!saved.manual,
        times: [...new Set(team.jobs.map(j => j.time).filter(Boolean))],
        foremen: [...new Set(team.jobs.map(j => String(j.foreman || "").replace(/[A-Za-z0-9+\-()（）\[\]【】:：/／,，;；.。*#\s]+/g, "").trim()).filter(Boolean))],
        descriptions: [...new Set(team.jobs.map(j => j.workSummary || (j.description || "").split(/\r?\n/)[0]).filter(Boolean))],
        locations: [...new Set(team.jobs.map(j => j.location).filter(Boolean))],
        jobCount: team.jobs.length
      };
    });
  }

  function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (_) { return fallback; }
  }

  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { console.warn("本機快取寫入失敗:", key, e); }
  }

  const cloudState = {
    supabase: null,
    user: null,
    profile: null,
    ready: false,
    teamStateLoaded: false,
    historyRows: [],
    listeners: new Set()
  };

  function isLoggedIn() {
    return !!cloudState.user;
  }

  function isAdmin() {
    if (!cloudState.user) return false;
    const email = String(cloudState.user.email || "").trim().toLowerCase();
    if (ADMIN_EMAILS.includes(email)) return true;
    return cloudState.profile?.sub_role === "admin" || cloudState.profile?.role === "admin";
  }

  function isAssistant() {
    if (!cloudState.user || isAdmin()) return false;
    const email = String(cloudState.user.email || "").trim().toLowerCase();
    if (email === GUEST_EMAIL) return true;
    return cloudState.profile?.sub_role === "assistant" || cloudState.profile?.staff_id === "__assistant__";
  }

  function isInspector() {
    return isLoggedIn() && !isAdmin() && !isAssistant();
  }

  function isRestrictedInspector() {
    return isLoggedIn() && !isAdmin();
  }

  function canUploadWork() {
    return isAdmin() || isAssistant();
  }

  function canEditDailyNotes() {
    return isAdmin() || isInspector();
  }

  function getMyStaffId() {
    if (isAssistant()) return "";
    return cloudState.profile?.staff_id || localStorage.getItem("dispatch-my-staff-id") || "";
  }

  function getMyStaffName() {
    if (isAssistant()) return "";
    const myId = getMyStaffId();
    if (!myId) return "";
    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const found = (rosterData.roster || []).find(s => s.id === myId);
    return found?.name || cloudState.profile?.staff_name || "";
  }

  function notifyListeners(reason) {
    for (const cb of cloudState.listeners) {
      try { cb({ ...getSnapshot(), reason }); } catch (e) { console.warn("AppCloud listener error", e); }
    }
  }

  function getSnapshot() {
    return {
      ready: cloudState.ready,
      loggedIn: isLoggedIn(),
      isAdmin: isAdmin(),
      isAssistant: isAssistant(),
      isInspector: isInspector(),
      isRestrictedInspector: isRestrictedInspector(),
      canUploadWork: canUploadWork(),
      canEditDailyNotes: canEditDailyNotes(),
      user: cloudState.user,
      profile: cloudState.profile,
      myStaffId: getMyStaffId(),
      myStaffName: getMyStaffName(),
      supabase: cloudState.supabase,
      historyRows: cloudState.historyRows
    };
  }

  function injectSharedStylesAndModal() {
    if (!document.getElementById("app-cloud-shared-style")) {
      const style = document.createElement("style");
      style.id = "app-cloud-shared-style";
      style.textContent = `
        .app-ver-badge{font-size:10px;font-weight:800;color:#93c5fd;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.18);padding:3px 7px;border-radius:12px;letter-spacing:.04em}
        .module-nav a.nav-btn,.nav-btn{background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:6px;padding:4px 9px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:1.2;transition:all .15s;text-decoration:none}
        .module-nav a.nav-btn:hover,.nav-btn:hover{background:#087f78;border-color:#087f78;color:#fff}
        .cloud-dot{width:7px;height:7px;border-radius:50%;background:#9bb0b8;display:inline-block;transition:all .2s}
        .cloud-dot.connected{background:#38d39f;box-shadow:0 0 6px #38d39f}
        .role-pill-nav{font-size:10px;font-weight:800;padding:2px 6px;border-radius:10px;background:rgba(255,255,255,0.16);color:#e2f6f3}
        .role-pill-nav.admin{background:#fef3c7;color:#92400e}
        .role-pill-nav.inspector{background:#dbeafe;color:#1e40af}
        .role-pill-nav.assistant{background:#fef3c7;color:#78350f}
        body.ac-gate-locked{overflow:hidden}
        body.ac-gate-locked > *:not(#app-login-gate){visibility:hidden}
        .ac-login-gate{position:fixed;inset:0;z-index:20000;background:linear-gradient(145deg,#0f293c 0%,#17364c 55%,#0b4f53 100%);display:flex;align-items:center;justify-content:center;padding:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif}
        .ac-login-gate[hidden]{display:none!important}
        .ac-gate-card{background:#fff;border-radius:18px;box-shadow:0 28px 60px rgba(0,0,0,0.38);width:100%;max-width:430px;padding:28px 26px;border:1px solid rgba(255,255,255,0.2);color:#172a3a}
        .ac-gate-brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}
        .ac-gate-mark{width:44px;height:44px;border-radius:12px;background:#59c5b2;color:#123344;display:grid;place-items:center;font-weight:900;font-size:21px;flex:0 0 auto}
        .ac-gate-brand h2{margin:0;font-size:19px;font-weight:900;color:#17364c}
        .ac-gate-brand p{margin:3px 0 0;font-size:12px;color:#6d7b86}
        .ac-gate-loading{padding:26px 10px;text-align:center;color:#526673;font-size:13px;font-weight:700}
        .ac-gate-field{display:flex;flex-direction:column;gap:5px;margin-bottom:11px}
        .ac-gate-field label{font-size:12px;font-weight:700;color:#17364c}
        .ac-gate-field input{border:1px solid #cbd5e1;border-radius:9px;padding:10px 12px;font:inherit;font-size:14px;color:#172a3a;background:#fff}
        .ac-gate-field input:focus{outline:none;border-color:#087f78;box-shadow:0 0 0 3px rgba(8,127,120,0.12)}
        .ac-gate-submit{width:100%;padding:11px 16px;border:0;border-radius:9px;background:#087f78;color:#fff;font:800 14px inherit;cursor:pointer;margin-top:4px}
        .ac-gate-submit:hover{background:#066b65}
        .ac-gate-submit:disabled{opacity:.5;cursor:not-allowed}
        .ac-gate-foot{margin-top:14px;padding:10px 12px;border-radius:9px;background:#f4f8f9;font-size:11px;color:#526673;line-height:1.55}
        .ac-modal-overlay{position:fixed;inset:0;background:rgba(18,40,56,0.6);backdrop-filter:blur(3px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}
        .ac-modal-overlay[hidden]{display:none!important}
        .ac-modal-card{background:#fff;border-radius:16px;box-shadow:0 24px 48px rgba(0,0,0,0.25);width:100%;max-width:680px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid #dce5e9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif}
        .ac-modal-head{padding:16px 20px;background:#17364c;color:#fff;display:flex;align-items:center;justify-content:space-between}
        .ac-modal-head h3{margin:0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px}
        .ac-modal-close{background:none;border:0;color:#c6d8df;font-size:22px;cursor:pointer;line-height:1;padding:0 4px}
        .ac-modal-close:hover{color:#fff}
        .ac-modal-body{padding:18px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;color:#172a3a}
        .ac-auth-box{background:#f7fafb;border:1px solid #dce5e9;border-radius:12px;padding:14px}
        .ac-auth-box h4{margin:0 0 10px;font-size:13px;color:#17364c;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
        .ac-admin-box{background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:14px}
        .ac-admin-box[hidden]{display:none}
        .ac-admin-box h4{margin:0 0 10px;font-size:13px;color:#92400e;display:flex;align-items:center;justify-content:space-between;gap:8px}
        .ac-user-list{margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:190px;overflow-y:auto}
        .ac-user-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid #fde68a;border-radius:8px;padding:7px 10px;font-size:12px}
        .ac-user-row select{border:1px solid #dce5e9;border-radius:6px;padding:4px 7px;font:inherit;font-size:11px;background:#fff}
        .ac-ms-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:9px;padding:10px 14px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font:700 13px inherit;cursor:pointer;margin-bottom:10px;transition:.15s;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
        .ac-ms-btn:hover{background:#f8fafc;border-color:#087f78}
        .ac-divider{display:flex;align-items:center;gap:8px;font-size:11px;color:#82909a;margin:8px 0}
        .ac-divider::before,.ac-divider::after{content:"";flex:1;height:1px;background:#e2e8f0}
        .ac-auth-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
        .ac-auth-row input,.ac-auth-row select{min-width:130px;flex:1;border:1px solid #dce5e9;border-radius:7px;padding:8px 10px;font:inherit;font-size:12px;background:#fff;color:#172a3a}
        .ac-btn{border:1px solid #dce5e9;border-radius:7px;padding:8px 12px;background:#fff;color:#17364c;font:700 11px inherit;cursor:pointer;white-space:nowrap}
        .ac-btn.primary{background:#087f78;border-color:#087f78;color:#fff}
        .ac-btn:disabled{opacity:.45;cursor:not-allowed}
        .ac-status{font-size:11px;color:#6d7b86;margin:8px 0 0;line-height:1.5}
        .ac-status.error{color:#b42318}
        .ac-role-badge{font-size:11px;font-weight:800;padding:3px 8px;border-radius:6px}
        .ac-role-admin{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
        .ac-role-inspector{background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe}
        .ac-role-assistant{background:#fef3c7;color:#92400e;border:1px solid #fcd34d}
        .ac-bind-row{margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
        .ac-bind-row[hidden]{display:none}
        .ac-bind-row select{border:1px solid #dce5e9;border-radius:7px;padding:6px 9px;font:inherit;font-size:12px;background:#fff}
        .ac-history-list{display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;border:1px solid #dce5e9;border-radius:10px;padding:8px;background:#fbfcfc}
        .ac-history-item{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#fff;border:1px solid #dce5e9;border-radius:8px;gap:10px}
        .ac-history-item:hover{border-color:#087f78}
        .ac-history-date{font-size:13px;font-weight:800;color:#17364c}
        .ac-history-badge{font-size:10px;color:#087f78;background:#dff3ef;padding:2px 6px;border-radius:4px;font-weight:700;margin-left:6px}
        .ac-history-meta{font-size:11px;color:#6d7b86;margin-top:2px}
        .ac-history-empty{padding:22px 14px;text-align:center;color:#6d7b86;font-size:12px}
        .ac-notice{font-size:11px;color:#526673;line-height:1.5;background:#f4f8f9;padding:9px 12px;border-radius:8px}
        .rbac-banner{margin:0 0 16px;padding:11px 16px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;font-size:12px;line-height:1.5;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
        .rbac-banner[hidden]{display:none}
      `;
      document.head.appendChild(style);
    }

    // 確保頁面上只有一個 #app-login-gate 與 #history-modal
    const oldGate = document.getElementById("app-login-gate");
    if (oldGate) oldGate.remove();

    const gate = document.createElement("div");
    gate.className = "ac-login-gate";
    gate.id = "app-login-gate";
    gate.innerHTML = `
      <div class="ac-gate-card" role="dialog" aria-modal="true" aria-labelledby="ac-gate-title">
        <div class="ac-gate-brand">
          <div class="ac-gate-mark">台</div>
          <div>
            <h2 id="ac-gate-title">台電檢驗員派工系統</h2>
            <p>TAIPOWER INSPECTOR · 團隊雲端認證閘門</p>
          </div>
        </div>
        <div id="ac-gate-loading" class="ac-gate-loading">正在驗證 Supabase 雲端登入狀態…</div>
        <div id="ac-gate-form-wrap" hidden>
          <button type="button" class="ac-ms-btn" id="ac-gate-ms-login">
            <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
            使用 Microsoft 帳號登入（OneDrive / Outlook）
          </button>
          <div class="ac-divider">或使用帳號／Email 密碼登入</div>
          <form id="ac-gate-form">
            <div class="ac-gate-field">
              <label for="ac-gate-email">帳號或電子郵件</label>
              <input id="ac-gate-email" type="text" autocomplete="username" placeholder="帳號簡稱（如 guest）或完整 Email" required>
            </div>
            <div class="ac-gate-field">
              <label for="ac-gate-password">密碼</label>
              <input id="ac-gate-password" type="password" autocomplete="current-password" placeholder="請輸入密碼" required>
            </div>
            <button id="ac-gate-login-btn" class="ac-gate-submit" type="submit">登入系統</button>
          </form>
          <p id="ac-gate-msg" class="ac-status" role="status"></p>
          <div class="ac-gate-foot">
            🔒 本系統採內部帳號控管，未開放外部公開註冊。<br>
            如需新增系統帳號、重設密碼或調整權限，請洽最高使用者（管理員）統一建立。
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(gate);
    document.body.classList.add("ac-gate-locked");

    const oldModal = document.getElementById("history-modal");
    if (oldModal) oldModal.remove();

    const modal = document.createElement("div");
    modal.className = "ac-modal-overlay";
    modal.id = "history-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="ac-modal-card" role="dialog" aria-modal="true" aria-labelledby="ac-modal-title">
        <div class="ac-modal-head">
          <h3 id="ac-modal-title">☁ 雲端帳號與歷史查詢</h3>
          <button class="ac-modal-close" id="ac-modal-close" type="button" aria-label="關閉">×</button>
        </div>
        <div class="ac-modal-body">
          <div class="ac-auth-box">
            <h4>
              <span>雲端帳號與角色權限</span>
              <span id="ac-user-status" style="font-size:11px;color:#6d7b86">檢查連線中…</span>
            </h4>
            <div id="ac-auth-inputs">
              <button type="button" class="ac-ms-btn" id="ac-ms-login">
                <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
                使用 Microsoft 帳號登入（OneDrive / Outlook）
              </button>
              <div class="ac-divider">或使用帳號／Email 密碼登入</div>
              <div class="ac-auth-row">
                <input id="ac-email" type="text" autocomplete="username" placeholder="帳號或 Email（例：guest）">
                <input id="ac-password" type="password" autocomplete="current-password" placeholder="密碼">
                <button id="ac-login" class="ac-btn primary" type="button">登入</button>
              </div>
            </div>
            <div id="ac-auth-logged" hidden>
              <div class="ac-auth-row">
                <span id="ac-email-label" style="font-size:13px;font-weight:800;color:#17364c"></span>
                <span id="ac-role-badge" class="ac-role-badge"></span>
                <button id="ac-refresh" class="ac-btn" type="button" style="margin-left:auto">重新整理同步</button>
                <button id="ac-logout" class="ac-btn" type="button">登出</button>
              </div>
              <div class="ac-bind-row" id="ac-bind-row">
                <label for="ac-bind-staff" style="font-weight:700;color:#17364c">對應同仁姓名：</label>
                <select id="ac-bind-staff"></select>
                <span style="color:#6d7b86;font-size:11px" id="ac-bind-hint">一般檢驗員請綁定自己的姓名，即可於「每月出勤」點擊本人休假／加班</span>
              </div>
            </div>
            <p id="ac-auth-msg" class="ac-status" role="status"></p>
          </div>
          <div class="ac-admin-box" id="ac-admin-box" hidden>
            <h4>
              <span>👑 管理員專屬：帳號註冊與權限管理</span>
              <span style="font-size:11px;font-weight:600;color:#b45309">帳號建立後即可直接登入</span>
            </h4>
            <div class="ac-auth-row">
              <input id="ac-reg-email" type="text" placeholder="新帳號或 Email（例：guest2）">
              <input id="ac-reg-password" type="password" placeholder="密碼（至少 6 碼）">
              <select id="ac-reg-role" style="flex:0 0 135px">
                <option value="inspector">檢驗員</option>
                <option value="assistant">助理（僅上傳工作）</option>
                <option value="admin">管理員</option>
              </select>
              <select id="ac-reg-staff" style="flex:0 0 130px"></select>
              <button id="ac-reg-btn" class="ac-btn primary" type="button">➕ 建立帳號</button>
            </div>
            <p id="ac-admin-msg" class="ac-status"></p>
            <div class="ac-user-list" id="ac-user-list"></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong style="font-size:13px;color:#17364c">團隊雲端歷史與預存紀錄</strong>
              <small style="font-size:11px;color:#6d7b86">點擊「查看每日工作」將直接開啟每日工作總表</small>
            </div>
            <div class="ac-history-list" id="ac-history-list">
              <div class="ac-history-empty">尚未登入或正在載入…</div>
            </div>
          </div>
          <div class="ac-notice">
            💡 <strong>角色權限說明：</strong>最高使用者（<code>${esc(ADMIN_EMAIL)}</code>）可統一建立帳號、管理名單、指派每日派工；助理（如 <code>guest</code>）僅可於「上傳工作」匯入施工資料與預先登錄任意日期之檢驗員驗收紀錄，其餘頁面均為純觀看；一般檢驗員可於「每月出勤」點選本人狀態與於「每日工作」填寫備註及驗收紀錄。
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function setAuthMsg(msg, isError = false) {
    for (const id of ["ac-auth-msg", "ac-gate-msg"]) {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = msg;
        el.classList.toggle("error", isError);
      }
    }
  }

  function setAdminMsg(msg, isError = false) {
    const el = document.getElementById("ac-admin-msg");
    if (el) {
      el.textContent = msg;
      el.classList.toggle("error", isError);
    }
  }

  function populateBindSelect() {
    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const roster = rosterData.roster || [];
    const myId = getMyStaffId();
    const sel = document.getElementById("ac-bind-staff");
    if (sel) {
      sel.innerHTML = `<option value="">-- 請選擇您的姓名 --</option>` +
        roster.map(s => `<option value="${esc(s.id)}"${s.id === myId ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    }
    const regSel = document.getElementById("ac-reg-staff");
    if (regSel) {
      const prev = regSel.value;
      regSel.innerHTML = `<option value="">-- 綁定姓名（選填）--</option>` +
        roster.map(s => `<option value="${esc(s.id)}"${s.id === prev ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    }
  }

  function updateHeaderAndModalUI() {
    document.querySelectorAll(".app-ver-badge").forEach(el => {
      el.textContent = window.APP_VERSION;
    });
    const signedIn = isLoggedIn();
    const admin = isAdmin();
    const assistant = isAssistant();
    const myName = getMyStaffName();

    const gate = document.getElementById("app-login-gate");
    const gateLoading = document.getElementById("ac-gate-loading");
    const gateFormWrap = document.getElementById("ac-gate-form-wrap");
    if (gate) {
      if (signedIn) {
        gate.hidden = true;
        document.body.classList.remove("ac-gate-locked");
      } else {
        gate.hidden = false;
        document.body.classList.add("ac-gate-locked");
        if (gateLoading) gateLoading.hidden = cloudState.ready;
        if (gateFormWrap) gateFormWrap.hidden = !cloudState.ready;
      }
    }

    document.querySelectorAll(".cloud-dot").forEach(dot => dot.classList.toggle("connected", signedIn));
    const navBtn = document.getElementById("nav-history-btn");
    if (navBtn) {
      let labelSpan = navBtn.querySelector(".nav-history-label");
      if (!labelSpan) {
        const dotHtml = '<span class="cloud-dot' + (signedIn ? " connected" : "") + '" id="nav-cloud-dot"></span>';
        navBtn.innerHTML = `${dotHtml}<span class="nav-history-label">歷史查詢</span>`;
        labelSpan = navBtn.querySelector(".nav-history-label");
      }
      if (!signedIn) {
        labelSpan.textContent = "歷史查詢 / 登入";
        navBtn.title = "點擊登入 Microsoft 或 Supabase 帳號並查詢歷史紀錄";
      } else if (admin) {
        labelSpan.innerHTML = `歷史查詢 <span class="role-pill-nav admin">👑 管理員</span>`;
        navBtn.title = `最高使用者：${formatUserDisplay(cloudState.user.email)}`;
      } else if (assistant) {
        labelSpan.innerHTML = `歷史查詢 <span class="role-pill-nav assistant">📤 助理(${esc(formatUserDisplay(cloudState.user.email).replace("（助理專用）", ""))})</span>`;
        navBtn.title = `助理專用帳號：${cloudState.user.email}`;
      } else {
        const displayTag = myName ? `👤 ${esc(myName)}` : "👤 檢驗員";
        labelSpan.innerHTML = `歷史查詢 <span class="role-pill-nav inspector">${displayTag}</span>`;
        navBtn.title = `檢驗員：${cloudState.user.email}`;
      }
    }

    const inputs = document.getElementById("ac-auth-inputs");
    const logged = document.getElementById("ac-auth-logged");
    const statusEl = document.getElementById("ac-user-status");
    const emailLabel = document.getElementById("ac-email-label");
    const roleBadge = document.getElementById("ac-role-badge");
    const bindRow = document.getElementById("ac-bind-row");
    const adminBox = document.getElementById("ac-admin-box");
    if (inputs) inputs.hidden = signedIn;
    if (logged) logged.hidden = !signedIn;
    if (statusEl) statusEl.textContent = signedIn ? "已連線登入" : "尚未登入";
    if (signedIn && emailLabel) emailLabel.textContent = formatUserDisplay(cloudState.user.email);
    if (signedIn && roleBadge) {
      if (admin) {
        roleBadge.textContent = "👑 最高使用者";
        roleBadge.className = "ac-role-badge ac-role-admin";
      } else if (assistant) {
        roleBadge.textContent = "📤 助理（上傳工作／預登驗收）";
        roleBadge.className = "ac-role-badge ac-role-assistant";
      } else {
        roleBadge.textContent = "👤 一般檢驗員";
        roleBadge.className = "ac-role-badge ac-role-inspector";
      }
    }
    if (bindRow) bindRow.hidden = !(signedIn && !assistant);
    if (adminBox) adminBox.hidden = !(signedIn && admin);
    populateBindSelect();
  }

  async function syncUserProfile() {
    if (!cloudState.supabase || !cloudState.user) {
      cloudState.profile = null;
      return;
    }
    const uid = cloudState.user.id;
    const email = String(cloudState.user.email || "").trim();
    const lowerEmail = email.toLowerCase();
    const isAdminEmail = ADMIN_EMAILS.includes(lowerEmail);
    const isGuestEmail = lowerEmail === GUEST_EMAIL;

    const { data: existing } = await cloudState.supabase
      .from("user_profiles")
      .select("user_id,email,role,sub_role,staff_id,staff_name")
      .eq("user_id", uid)
      .maybeSingle();

    if (existing) {
      let nextRole = existing.role;
      let nextSubRole = existing.sub_role || existing.role || "inspector";
      if (isAdminEmail && (existing.role !== "admin" || existing.sub_role !== "admin")) {
        nextRole = "admin";
        nextSubRole = "admin";
        await cloudState.supabase.from("user_profiles").update({ role: "admin", sub_role: "admin", updated_at: new Date().toISOString() }).eq("user_id", uid);
      } else if (isGuestEmail && existing.sub_role !== "assistant") {
        nextSubRole = "assistant";
      }
      cloudState.profile = { ...existing, role: nextRole, sub_role: nextSubRole };
      if (existing.staff_id && nextSubRole !== "assistant") {
        localStorage.setItem("dispatch-my-staff-id", existing.staff_id);
      }
    } else {
      let guessedStaffId = isGuestEmail ? "__assistant__" : (localStorage.getItem("dispatch-my-staff-id") || null);
      let guessedStaffName = isGuestEmail ? "助理專用(guest)" : null;
      const metaName = cloudState.user.user_metadata?.full_name || cloudState.user.user_metadata?.name || "";
      if (!isGuestEmail && !guessedStaffId && metaName) {
        const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
        const matched = (rosterData.roster || []).find(s => metaName.includes(s.name) || s.name.includes(metaName));
        if (matched) {
          guessedStaffId = matched.id;
          guessedStaffName = matched.name;
          localStorage.setItem("dispatch-my-staff-id", matched.id);
        }
      }
      const nextSubRole = isAdminEmail ? "admin" : (isGuestEmail ? "assistant" : "inspector");
      const newProf = {
        user_id: uid,
        email,
        role: isAdminEmail ? "admin" : "inspector",
        sub_role: nextSubRole,
        staff_id: guessedStaffId,
        staff_name: guessedStaffName,
        updated_at: new Date().toISOString()
      };
      const { error } = await cloudState.supabase.from("user_profiles").upsert(newProf, { onConflict: "user_id" });
      cloudState.profile = error ? newProf : newProf;
    }
  }

  async function bindMyStaff(staffId) {
    if (isAssistant()) return;
    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const staff = (rosterData.roster || []).find(s => s.id === staffId) || null;
    if (staffId) localStorage.setItem("dispatch-my-staff-id", staffId);
    else localStorage.removeItem("dispatch-my-staff-id");

    if (cloudState.supabase && cloudState.user) {
      await cloudState.supabase.from("user_profiles").upsert({
        user_id: cloudState.user.id,
        email: cloudState.user.email || "",
        role: isAdmin() ? "admin" : "inspector",
        sub_role: isAdmin() ? "admin" : "inspector",
        staff_id: staffId || null,
        staff_name: staff ? staff.name : null,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });
      if (cloudState.profile) {
        cloudState.profile.staff_id = staffId || null;
        cloudState.profile.staff_name = staff ? staff.name : null;
      }
    }
    updateHeaderAndModalUI();
    notifyListeners("bind_staff");
  }

  async function pullTeamState() {
    if (!cloudState.supabase || !cloudState.user) return false;
    const [rosterRes, attRes, notesRes, accRes] = await Promise.all([
      cloudState.supabase
        .from("staff_roster")
        .select("id,name,supervisor,default_attending,default_noncritical,sort_order")
        .eq("active", true)
        .order("sort_order", { ascending: true }),
      cloudState.supabase
        .from("attendance_records")
        .select("work_date,staff_id,status_type,attending,noncritical,note"),
      cloudState.supabase
        .from("calendar_day_notes")
        .select("work_date,note"),
      cloudState.supabase
        .from("acceptance_records")
        .select("id,work_date,zone,batch,staff_name,note,created_by,created_at")
        .order("work_date", { ascending: true })
        .order("created_at", { ascending: true })
    ]);

    if (rosterRes.error || attRes.error || notesRes.error) {
      const err = rosterRes.error || attRes.error || notesRes.error;
      console.warn("讀取正規化團隊資料失敗:", err.message);
      return false;
    }

    const localRosterWrap = loadJson("dispatch-roster-v2", { roster: [], daily: {} });
    const localDayNotes = loadJson("dispatch-day-notes-v1", {});

    let cloudRoster = (rosterRes.data || []).map(r => ({
      id: r.id,
      name: r.name,
      supervisor: !!r.supervisor,
      attending: !!r.default_attending,
      noncritical: !!r.default_noncritical,
      defaultAttending: !!r.default_attending,
      defaultNoncritical: !!r.default_noncritical
    }));

    // 若管理員首次連線且雲端尚無人員名單，將本機資料初始化至雲端
    if (isAdmin() && !cloudRoster.length && localRosterWrap.roster?.length) {
      await pushTeamStateRoster(localRosterWrap.roster);
      cloudRoster = localRosterWrap.roster;
    }

    const cloudDaily = {};
    for (const rec of (attRes.data || [])) {
      if (!cloudDaily[rec.work_date]) cloudDaily[rec.work_date] = {};
      cloudDaily[rec.work_date][rec.staff_id] = {
        attending: !!rec.attending,
        noncritical: !!rec.noncritical,
        statusType: rec.status_type || "normal",
        note: rec.note || ""
      };
    }

    const cloudDayNotes = {};
    for (const row of (notesRes.data || [])) {
      if (row.note) cloudDayNotes[row.work_date] = row.note;
    }
    if (isAdmin() && !(notesRes.data || []).length && Object.keys(localDayNotes).length) {
      await pushTeamStateDayNotes(localDayNotes);
      Object.assign(cloudDayNotes, localDayNotes);
    }

    let changed = false;
    const nextRoster = cloudRoster.length ? cloudRoster : (localRosterWrap.roster || []);
    const nextDaily = Object.keys(cloudDaily).length
      ? { ...(localRosterWrap.daily || {}), ...cloudDaily }
      : (localRosterWrap.daily || {});
    if (cloudRoster.length || Object.keys(cloudDaily).length) {
      saveJson("dispatch-roster-v2", { roster: nextRoster, daily: nextDaily });
      changed = true;
    }
    if ((notesRes.data || []).length || Object.keys(cloudDayNotes).length) {
      saveJson("dispatch-day-notes-v1", cloudDayNotes);
      changed = true;
    }
    if (accRes && !accRes.error) {
      const cloudAcceptance = {};
      for (const r of (accRes.data || [])) {
        if (!cloudAcceptance[r.work_date]) cloudAcceptance[r.work_date] = [];
        cloudAcceptance[r.work_date].push({
          id: r.id,
          zone: r.zone,
          batch: r.batch || "",
          staff: r.staff_name || "",
          note: r.note || "",
          createdBy: r.created_by || null
        });
      }
      saveJson("dispatch-acceptance-v1", cloudAcceptance);
      changed = true;
    }

    cloudState.teamStateLoaded = true;
    if (changed) {
      populateBindSelect();
      updateHeaderAndModalUI();
      notifyListeners("team_state_pulled");
    }
    return true;
  }

  async function pushTeamStateRoster(roster) {
    if (!cloudState.supabase || !cloudState.user) return { ok: false, reason: "not_logged_in" };
    if (!isAdmin()) return { ok: false, reason: "forbidden" };
    const nowIso = new Date().toISOString();
    const rows = (roster || []).map((s, idx) => ({
      id: s.id,
      name: s.name,
      supervisor: !!s.supervisor,
      default_attending: s.defaultAttending !== undefined ? !!s.defaultAttending : true,
      default_noncritical: s.defaultNoncritical !== undefined ? !!s.defaultNoncritical : (s.id === "staff-1"),
      sort_order: idx + 1,
      active: true,
      updated_at: nowIso
    }));
    if (rows.length) {
      const { error } = await cloudState.supabase
        .from("staff_roster")
        .upsert(rows, { onConflict: "id" });
      if (error) {
        console.warn("寫入 staff_roster 失敗:", error.message);
        return { ok: false, error: error.message };
      }
    }
    const activeIds = new Set(rows.map(r => r.id));
    const { data: existingRows } = await cloudState.supabase
      .from("staff_roster")
      .select("id")
      .eq("active", true);
    const deactivatedIds = (existingRows || []).map(r => r.id).filter(id => !activeIds.has(id));
    if (deactivatedIds.length) {
      await cloudState.supabase
        .from("staff_roster")
        .update({ active: false, updated_at: nowIso })
        .in("id", deactivatedIds);
    }
    return { ok: true };
  }

  async function pushTeamStateDayNotes(dayNotes) {
    if (!cloudState.supabase || !cloudState.user) return { ok: false, reason: "not_logged_in" };
    if (!isAdmin()) return { ok: false, reason: "forbidden" };
    const nowIso = new Date().toISOString();
    const entries = Object.entries(dayNotes || {}).filter(([, val]) => String(val || "").trim() !== "");
    if (entries.length) {
      const rows = entries.map(([workDate, note]) => ({
        work_date: workDate,
        note: String(note),
        updated_by: cloudState.user.id,
        updated_at: nowIso
      }));
      const { error } = await cloudState.supabase
        .from("calendar_day_notes")
        .upsert(rows, { onConflict: "work_date" });
      if (error) {
        console.warn("寫入 calendar_day_notes 失敗:", error.message);
        return { ok: false, error: error.message };
      }
    }
    const activeDates = new Set(entries.map(([d]) => d));
    const { data: existingDates } = await cloudState.supabase
      .from("calendar_day_notes")
      .select("work_date");
    const removedDates = (existingDates || []).map(r => r.work_date).filter(d => !activeDates.has(d));
    if (removedDates.length) {
      await cloudState.supabase
        .from("calendar_day_notes")
        .delete()
        .in("work_date", removedDates);
    }
    return { ok: true };
  }

  // 以單列 upsert 寫入每日出勤，一般檢驗員僅能寫入自己 staff_id（與資料庫 RLS 同步把關）
  async function pushDailyAttendance(dateStr, partialDayMap, defaultsMap = {}) {
    if (!cloudState.supabase || !cloudState.user) return { ok: false, reason: "not_logged_in" };
    let entries;
    if (isRestrictedInspector()) {
      const myStaffId = getMyStaffId();
      if (!myStaffId) return { ok: false, reason: "unbound_staff" };
      entries = partialDayMap && partialDayMap[myStaffId] ? [[myStaffId, partialDayMap[myStaffId]]] : [];
      if (!entries.length) return { ok: false, reason: "forbidden" };
    } else {
      entries = Object.entries(partialDayMap || {});
    }
    if (!entries.length) return { ok: true };

    const nowIso = new Date().toISOString();
    const rows = entries.map(([staffId, rec]) => ({
      work_date: dateStr,
      staff_id: staffId,
      status_type: rec?.statusType || "normal",
      attending: rec?.attending !== undefined ? !!rec.attending : true,
      noncritical: !!rec?.noncritical,
      note: rec?.note || "",
      updated_by: cloudState.user.id,
      updated_at: nowIso
    }));

    const { error } = await cloudState.supabase
      .from("attendance_records")
      .upsert(rows, { onConflict: "work_date,staff_id" });

    if (error) {
      console.warn("寫入 attendance_records 失敗:", error.message);
      return { ok: false, error: error.message };
    }

    const localWrap = loadJson("dispatch-roster-v2", { roster: [], daily: {} });
    if (!localWrap.daily) localWrap.daily = {};
    localWrap.daily[dateStr] = {
      ...(defaultsMap || {}),
      ...(localWrap.daily[dateStr] || {}),
      ...Object.fromEntries(entries)
    };
    localStorage.setItem("dispatch-roster-v2", JSON.stringify(localWrap));
    return { ok: true };
  }

  async function saveWorkNoteRow(workDate, teamKey, note) {
    if (!cloudState.supabase || !cloudState.user) return { error: { message: "請先登入 Supabase。" } };
    if (!workDate || !teamKey) return { error: { message: "缺少日期或工班識別鍵。" } };
    return cloudState.supabase
      .from("daily_work_notes")
      .upsert({
        work_date: workDate,
        team_key: teamKey,
        note: String(note || ""),
        updated_by: cloudState.user.id,
        updated_at: new Date().toISOString()
      }, { onConflict: "work_date,team_key" });
  }

  async function addAcceptanceRow(workDate, rec) {
    if (!cloudState.supabase || !cloudState.user) return { data: null, error: { message: "請先登入 Supabase。" } };
    return cloudState.supabase
      .from("acceptance_records")
      .insert({
        work_date: workDate,
        zone: rec?.zone || "",
        batch: rec?.batch || "",
        staff_name: rec?.staff || "",
        note: rec?.note || "",
        created_by: cloudState.user.id
      })
      .select()
      .single();
  }

  async function deleteAcceptanceRow(id) {
    if (!cloudState.supabase || !cloudState.user) return { error: { message: "請先登入 Supabase。" } };
    if (!id) return { error: null };
    return cloudState.supabase
      .from("acceptance_records")
      .delete()
      .eq("id", id);
  }

  async function fetchAcceptanceRecords(options = {}) {
    if (!cloudState.supabase || !cloudState.user) {
      return { data: [], error: { message: "請先登入 Supabase。" } };
    }
    let query = cloudState.supabase
      .from("acceptance_records")
      .select("id,work_date,zone,batch,staff_name,note,created_by,created_at");
    if (options.workDate) {
      query = query.eq("work_date", options.workDate);
    } else if (options.fromDate) {
      query = query.gte("work_date", options.fromDate);
    }
    const { data, error } = await query
      .order("work_date", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) {
      return { data: [], error };
    }
    const rows = (data || []).map(r => ({
      id: r.id,
      workDate: r.work_date,
      zone: r.zone,
      batch: r.batch || "",
      staff: r.staff_name || "",
      note: r.note || "",
      createdBy: r.created_by || null
    }));

    const toLocalItem = r => ({
      id: r.id,
      zone: r.zone,
      batch: r.batch,
      staff: r.staff,
      note: r.note,
      createdBy: r.createdBy
    });
    const am = loadJson("dispatch-acceptance-v1", {});
    if (options.workDate) {
      am[options.workDate] = rows.map(toLocalItem);
    } else {
      for (const k of Object.keys(am)) {
        if (!options.fromDate || k >= options.fromDate) delete am[k];
      }
      for (const r of rows) {
        if (!am[r.workDate]) am[r.workDate] = [];
        am[r.workDate].push(toLocalItem(r));
      }
    }
    saveJson("dispatch-acceptance-v1", am);
    return { data: rows, error: null };
  }

  async function saveTeamDispatchHistory(workDate, firstStaff, payload) {
    if (!cloudState.supabase || !cloudState.user) {
      return { error: { message: "請先登入 Supabase。" } };
    }
    const nowIso = new Date().toISOString();

    if (isAdmin()) {
      const manualDay = payload?.manualAssignments?.[workDate] ?? payload?.manualAssignments ?? {};
      const { error: dispErr } = await cloudState.supabase
        .from("daily_dispatches")
        .upsert({
          work_date: workDate,
          first_staff: firstStaff,
          filename: payload?.filename || "",
          weather: payload?.weather || "晴",
          proximity_km: payload?.proximityKm ?? 10,
          coordinates: payload?.coordinates || { matched: 0, decoded: 0, total: 0, available: false },
          jobs: payload?.jobs || [],
          assignments: payload?.assignments || {},
          manual_assignments: manualDay,
          updated_by: cloudState.user.id,
          updated_at: nowIso
        }, { onConflict: "work_date" });
      if (dispErr) return { error: dispErr };
    }

    const noteEntries = Object.entries(payload?.workNotes || {});
    if (noteEntries.length) {
      const noteRows = noteEntries.map(([teamKey, noteVal]) => ({
        work_date: workDate,
        team_key: teamKey,
        note: String(noteVal || ""),
        updated_by: cloudState.user.id,
        updated_at: nowIso
      }));
      const { error: noteErr } = await cloudState.supabase
        .from("daily_work_notes")
        .upsert(noteRows, { onConflict: "work_date,team_key" });
      if (noteErr) return { error: noteErr };
    }

    const acceptanceList = Array.isArray(payload?.acceptance) ? payload.acceptance : [];
    const missingIndexes = [];
    const toInsert = [];
    acceptanceList.forEach((rec, idx) => {
      if (!rec?.id && rec?.zone) {
        missingIndexes.push(idx);
        toInsert.push({
          work_date: workDate,
          zone: rec.zone,
          batch: rec.batch || "",
          staff_name: rec.staff || "",
          note: rec.note || "",
          created_by: cloudState.user.id
        });
      }
    });
    if (toInsert.length) {
      const { data: insertedRows, error: accErr } = await cloudState.supabase
        .from("acceptance_records")
        .insert(toInsert)
        .select();
      if (accErr) return { error: accErr };
      if (Array.isArray(insertedRows) && insertedRows.length) {
        const am = loadJson("dispatch-acceptance-v1", {});
        const localList = am[workDate] || acceptanceList;
        missingIndexes.forEach((origIdx, i) => {
          if (insertedRows[i]?.id && localList[origIdx]) {
            localList[origIdx].id = insertedRows[i].id;
          }
        });
        am[workDate] = localList;
        saveJson("dispatch-acceptance-v1", am);
      }
    }

    await refreshCloudHistory();
    return { error: null };
  }

  function getDispatchAssignmentStats(jobs, assignments) {
    const assignMap = (assignments && typeof assignments === "object") ? assignments : {};
    const jobList = Array.isArray(jobs) ? jobs : [];
    if (jobList.length) {
      const teamKeys = [...new Set(jobList.map(j => `${j.contract}|||${j.crew}`))];
      const totalTeams = teamKeys.length;
      const assignedTeams = teamKeys.filter(k => Boolean(assignMap[k]?.staffId)).length;
      return {
        totalTeams,
        assignedTeams,
        anyAssigned: assignedTeams > 0,
        fullyAssigned: totalTeams > 0 && assignedTeams === totalTeams
      };
    }
    const vals = Object.values(assignMap);
    const totalTeams = vals.length;
    const assignedTeams = vals.filter(a => Boolean(a && a.staffId)).length;
    return {
      totalTeams,
      assignedTeams,
      anyAssigned: assignedTeams > 0,
      fullyAssigned: totalTeams > 0 && assignedTeams === totalTeams
    };
  }

  function isFullyAssigned(jobs, assignments) {
    return getDispatchAssignmentStats(jobs, assignments).fullyAssigned;
  }

  function hasAssignedStaff(assignments, jobs) {
    if (Array.isArray(jobs)) {
      return isFullyAssigned(jobs, assignments);
    }
    if (!assignments || typeof assignments !== "object") return false;
    return Object.values(assignments).some(a => a && a.staffId);
  }

  async function savePreUploadedWork(filename, allJobs, coordinates) {
    if (!cloudState.supabase || !cloudState.user) {
      return { error: { message: "請先登入雲端帳號後再上傳儲存。" }, savedDates: [] };
    }
    if (!canUploadWork()) {
      return { error: { message: "僅限助理或最高使用者上傳施工資料。" }, savedDates: [] };
    }
    const grouped = new Map();
    for (const job of (allJobs || [])) {
      if (!job?.date) continue;
      if (!grouped.has(job.date)) grouped.set(job.date, []);
      grouped.get(job.date).push(job);
    }
    const dates = [...grouped.keys()].sort();
    if (!dates.length) {
      return { error: { message: "檔案中沒有可用的施工日期資料。" }, savedDates: [] };
    }

    const nowIso = new Date().toISOString();
    const coordObj = coordinates || { matched: 0, decoded: 0, total: 0, available: false };

    const rawRows = dates.map(workDate => ({
      work_date: workDate,
      filename: filename || "預先上傳施工資料",
      coordinates: coordObj,
      jobs: grouped.get(workDate),
      uploaded_by: cloudState.user.id,
      updated_at: nowIso
    }));

    const { error } = await cloudState.supabase
      .from("raw_work_uploads")
      .upsert(rawRows, { onConflict: "work_date" });
    if (error) {
      return { error, savedDates: [] };
    }

    // 智慧合併（選項 B）：只讀取既有的 daily_dispatches 指派結果，不覆蓋主管已排好的指派
    const { data: existingDispatches } = await cloudState.supabase
      .from("daily_dispatches")
      .select("work_date,first_staff,weather,proximity_km,assignments,manual_assignments")
      .in("work_date", dates);
    const dispByDate = new Map((existingDispatches || []).map(r => [r.work_date, r]));

    const rosterWrap = loadJson("dispatch-roster-v2", { roster: [], daily: {} });
    const localRoster = rosterWrap.roster || [];
    const allDailyWork = loadJson("dispatch-daily-work-v1", {});
    const allCache = loadJson("dispatch-session-cache-v1", {});

    for (const row of rawRows) {
      const disp = dispByDate.get(row.work_date);
      const assignments = disp?.assignments || {};
      allDailyWork[row.work_date] = {
        date: row.work_date,
        filename: row.filename,
        firstStaff: disp?.first_staff || "",
        updatedAt: nowIso,
        items: buildDailyWorkItemsFromPayload({ jobs: row.jobs, assignments }, localRoster)
      };
      allCache[row.work_date] = {
        date: row.work_date,
        filename: row.filename,
        firstStaff: disp?.first_staff || "",
        proximityKm: Number(disp?.proximity_km) || 10,
        coordinates: coordObj,
        jobs: row.jobs,
        assignments
      };
    }
    saveJson("dispatch-daily-work-v1", allDailyWork);
    saveJson("dispatch-session-cache-v1", allCache);

    await refreshCloudHistory();
    notifyListeners("preupload_saved");
    return { error: null, savedDates: dates };
  }

  async function deleteCloudDispatch(workDate) {
    if (!cloudState.supabase || !cloudState.user) {
      return { error: { message: "請先登入 Supabase。" } };
    }
    if (!isAdmin()) {
      return { error: { message: "僅限最高使用者可移除雲端日期紀錄。" } };
    }
    const [rawDel, dispDel] = await Promise.all([
      cloudState.supabase.from("raw_work_uploads").delete().eq("work_date", workDate),
      cloudState.supabase.from("daily_dispatches").delete().eq("work_date", workDate)
    ]);
    const err = rawDel.error || dispDel.error;
    if (err) return { error: err };

    const allDailyWork = loadJson("dispatch-daily-work-v1", {});
    delete allDailyWork[workDate];
    localStorage.setItem("dispatch-daily-work-v1", JSON.stringify(allDailyWork));

    const allCache = loadJson("dispatch-session-cache-v1", {});
    delete allCache[workDate];
    localStorage.setItem("dispatch-session-cache-v1", JSON.stringify(allCache));

    if (localStorage.getItem("dispatch-active-date-v1") === workDate) {
      localStorage.removeItem("dispatch-active-date-v1");
    }

    await refreshCloudHistory();
    notifyListeners("dispatch_deleted");
    return { error: null };
  }

  function renderModalHistoryList(rows = []) {
    const list = document.getElementById("ac-history-list");
    if (!list) return;
    if (!isLoggedIn()) {
      list.innerHTML = '<div class="ac-history-empty">請先登入系統帳號，以讀取團隊雲端派工紀錄。</div>';
      return;
    }
    if (!rows.length) {
      list.innerHTML = '<div class="ac-history-empty">目前雲端尚無已儲存的派工或預存紀錄。</div>';
      return;
    }
    const admin = isAdmin();
    list.innerHTML = rows.map(row => {
      const jobsCount = row.payload?.jobs?.length || 0;
      const stats = row.assignmentStats || getDispatchAssignmentStats(row.payload?.jobs, row.payload?.assignments);
      const crewCount = stats.totalTeams;
      let badgeHtml;
      if (stats.fullyAssigned) {
        badgeHtml = '<span class="ac-history-badge">✓ 已排工</span>';
      } else if (stats.assignedTeams > 0) {
        badgeHtml = `<span class="ac-history-badge" style="background:#fef3c7;color:#92400e">⏳ 待指派（已派 ${stats.assignedTeams}/${stats.totalTeams}）</span>`;
      } else {
        badgeHtml = '<span class="ac-history-badge" style="background:#fef3c7;color:#92400e">⏳ 待指派（已預存）</span>';
      }
      const timeStr = new Date(row.updated_at).toLocaleString("zh-TW", { hour12: false });
      const dispatchLink = admin
        ? `<a class="ac-btn" href="index.html?date=${encodeURIComponent(row.work_date)}" style="text-decoration:none">前往派工</a>`
        : "";
      return `
        <div class="ac-history-item">
          <div>
            <div class="ac-history-date">${esc(rocDate(row.work_date))} ${badgeHtml}</div>
            <div class="ac-history-meta">更新：${esc(timeStr)}${jobsCount ? ` · ${jobsCount} 筆案件` : ""}${crewCount ? ` · ${crewCount} 組工作` : ""}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            ${dispatchLink}
            <button class="ac-btn primary" type="button" data-ac-load-date="${esc(row.work_date)}">查看每日工作</button>
          </div>
        </div>
      `;
    }).join("");
  }

  async function refreshCloudHistory() {
    if (!cloudState.supabase || !cloudState.user) {
      cloudState.historyRows = [];
      renderModalHistoryList([]);
      notifyListeners("history_updated");
      return [];
    }
    const listEl = document.getElementById("ac-history-list");
    if (listEl && !listEl.querySelector(".ac-history-item")) {
      listEl.innerHTML = '<div class="ac-history-empty">正在讀取雲端歷史紀錄…</div>';
    }
    const [rawRes, dispRes] = await Promise.all([
      cloudState.supabase
        .from("raw_work_uploads")
        .select("work_date,filename,jobs,updated_at")
        .order("work_date", { ascending: false }),
      cloudState.supabase
        .from("daily_dispatches")
        .select("work_date,first_staff,filename,weather,jobs,assignments,updated_at")
        .order("work_date", { ascending: false })
    ]);

    if (rawRes.error && dispRes.error) {
      const err = rawRes.error || dispRes.error;
      setAuthMsg(`讀取歷史紀錄失敗：${err.message}。請確認已在 Supabase 建立正規化資料表。`, true);
      if (listEl) listEl.innerHTML = `<div class="ac-history-empty" style="color:#b42318">讀取失敗：${esc(err.message)}</div>`;
      return [];
    }

    const rawByDate = new Map((rawRes.data || []).map(r => [r.work_date, r]));
    const dispByDate = new Map((dispRes.data || []).map(r => [r.work_date, r]));
    const allDates = [...new Set([...rawByDate.keys(), ...dispByDate.keys()])].sort((a, b) => b.localeCompare(a));

    const mapped = allDates.map(workDate => {
      const rawRow = rawByDate.get(workDate);
      const dispRow = dispByDate.get(workDate);
      const jobs = rawRow?.jobs?.length ? rawRow.jobs : (dispRow?.jobs || []);
      const assignments = dispRow?.assignments || {};
      const assignmentStats = getDispatchAssignmentStats(jobs, assignments);
      const updatedAt = [rawRow?.updated_at, dispRow?.updated_at].filter(Boolean).sort().pop() || new Date().toISOString();
      return {
        work_date: workDate,
        first_staff: dispRow?.first_staff || "",
        updated_at: updatedAt,
        assigned: assignmentStats.fullyAssigned,
        assignmentStats,
        payload: {
          filename: rawRow?.filename || dispRow?.filename || "",
          weather: dispRow?.weather || "晴",
          jobs,
          assignments
        }
      };
    });

    cloudState.historyRows = mapped;
    renderModalHistoryList(mapped);
    const roleLabel = isAdmin() ? "最高使用者" : (isAssistant() ? "助理（僅上傳工作）" : "檢驗員");
    setAuthMsg(`已登入 ${formatUserDisplay(cloudState.user.email)}（${roleLabel}），雲端共有 ${mapped.length} 筆每日紀錄。`);
    notifyListeners("history_updated");
    return mapped;
  }

  async function loadCloudDispatch(workDate, options = {}) {
    if (!cloudState.supabase || !cloudState.user || !workDate) return null;
    setAuthMsg(`正在讀取 ${rocDate(workDate)} 雲端資料…`);

    const [rawRes, dispRes, notesRes, accRes, attRes] = await Promise.all([
      cloudState.supabase
        .from("raw_work_uploads")
        .select("work_date,filename,coordinates,jobs,updated_at")
        .eq("work_date", workDate)
        .maybeSingle(),
      cloudState.supabase
        .from("daily_dispatches")
        .select("work_date,first_staff,filename,weather,proximity_km,coordinates,jobs,assignments,manual_assignments,updated_at")
        .eq("work_date", workDate)
        .maybeSingle(),
      cloudState.supabase
        .from("daily_work_notes")
        .select("team_key,note")
        .eq("work_date", workDate),
      cloudState.supabase
        .from("acceptance_records")
        .select("id,zone,batch,staff_name,note,created_by,created_at")
        .eq("work_date", workDate)
        .order("created_at", { ascending: true }),
      cloudState.supabase
        .from("attendance_records")
        .select("staff_id,status_type,attending,noncritical,note")
        .eq("work_date", workDate)
    ]);

    const raw = rawRes.data;
    const dispatch = dispRes.data;
    const hasExtraRecords = !!(accRes.data?.length || notesRes.data?.length || attRes.data?.length);
    if ((rawRes.error && dispRes.error) || (!raw && !dispatch && !hasExtraRecords)) {
      setAuthMsg(`讀取失敗：${(rawRes.error || dispRes.error)?.message || "找不到該日紀錄"}`, true);
      return null;
    }

    const existingRosterWrap = loadJson("dispatch-roster-v2", { roster: [], daily: {} });
    let mergedRoster = existingRosterWrap.roster || [];
    if (!mergedRoster.length) {
      const { data: rosterRows } = await cloudState.supabase
        .from("staff_roster")
        .select("id,name,supervisor,default_attending,default_noncritical,sort_order")
        .eq("active", true)
        .order("sort_order", { ascending: true });
      mergedRoster = (rosterRows || []).map(r => ({
        id: r.id,
        name: r.name,
        supervisor: !!r.supervisor,
        attending: !!r.default_attending,
        noncritical: !!r.default_noncritical,
        defaultAttending: !!r.default_attending,
        defaultNoncritical: !!r.default_noncritical
      }));
    }

    const mergedDaily = { ...(existingRosterWrap.daily || {}) };
    if (attRes.data?.length) {
      const dayAtt = {};
      for (const rec of attRes.data) {
        dayAtt[rec.staff_id] = {
          attending: !!rec.attending,
          noncritical: !!rec.noncritical,
          statusType: rec.status_type || "normal",
          note: rec.note || ""
        };
      }
      mergedDaily[workDate] = dayAtt;
    }
    saveJson("dispatch-roster-v2", { roster: mergedRoster, daily: mergedDaily });

    const existingManual = loadJson("dispatch-manual-v1", {});
    existingManual[workDate] = dispatch?.manual_assignments || {};
    saveJson("dispatch-manual-v1", existingManual);

    const wm = loadJson("dispatch-weather-v1", {});
    wm[workDate] = dispatch?.weather || "晴";
    saveJson("dispatch-weather-v1", wm);

    const am = loadJson("dispatch-acceptance-v1", {});
    am[workDate] = (accRes.data || []).map(r => ({
      id: r.id,
      zone: r.zone,
      batch: r.batch || "",
      staff: r.staff_name || "",
      note: r.note || "",
      createdBy: r.created_by || null
    }));
    saveJson("dispatch-acceptance-v1", am);

    const wn = loadJson("dispatch-work-notes-v1", {});
    const dayWorkNotes = {};
    for (const r of (notesRes.data || [])) {
      if (r.note !== null && r.note !== undefined) dayWorkNotes[r.team_key] = r.note;
    }
    wn[workDate] = dayWorkNotes;
    saveJson("dispatch-work-notes-v1", wn);

    const useRawJobs = raw?.jobs?.length;
    const payloadShape = {
      filename: (useRawJobs ? raw.filename : dispatch?.filename) || raw?.filename || dispatch?.filename || "雲端歷史紀錄",
      jobs: useRawJobs ? raw.jobs : (dispatch?.jobs || []),
      assignments: dispatch?.assignments || {},
      roster: mergedRoster,
      proximityKm: Number(dispatch?.proximity_km) || 10,
      coordinates: (useRawJobs ? raw.coordinates : dispatch?.coordinates) || { matched: 0, decoded: 0, total: 0, available: false }
    };
    const mergedUpdatedAt = [raw?.updated_at, dispatch?.updated_at].filter(Boolean).sort().pop() || new Date().toISOString();

    if (raw || dispatch) {
      // 重建 daily.html 所需的 dispatch-daily-work-v1 與 dispatch-session-cache-v1
      const allDailyWork = loadJson("dispatch-daily-work-v1", {});
      allDailyWork[workDate] = {
        date: workDate,
        filename: payloadShape.filename,
        firstStaff: dispatch?.first_staff || "",
        updatedAt: mergedUpdatedAt,
        items: buildDailyWorkItemsFromPayload(payloadShape, mergedRoster)
      };
      saveJson("dispatch-daily-work-v1", allDailyWork);

      const allCache = loadJson("dispatch-session-cache-v1", {});
      allCache[workDate] = {
        date: workDate,
        filename: payloadShape.filename,
        firstStaff: dispatch?.first_staff || "",
        proximityKm: payloadShape.proximityKm,
        coordinates: payloadShape.coordinates,
        jobs: payloadShape.jobs,
        assignments: payloadShape.assignments
      };
      saveJson("dispatch-session-cache-v1", allCache);
    }
    try { localStorage.setItem("dispatch-active-date-v1", workDate); } catch (_) {}

    closeModal();
    if (options.redirect !== false) {
      location.href = `daily.html?date=${encodeURIComponent(workDate)}`;
    } else {
      notifyListeners("dispatch_loaded");
    }
    return {
      work_date: workDate,
      first_staff: dispatch?.first_staff || "",
      updated_at: mergedUpdatedAt,
      payload: payloadShape
    };
  }

  async function refreshAdminUsersList() {
    const listEl = document.getElementById("ac-user-list");
    if (!listEl || !cloudState.supabase || !isAdmin()) return;
    const { data, error } = await cloudState.supabase
      .from("user_profiles")
      .select("user_id,email,role,sub_role,staff_id,staff_name,updated_at")
      .order("updated_at", { ascending: false });
    if (error) {
      listEl.innerHTML = `<div style="font-size:11px;color:#b42318">無法讀取帳號清單：${esc(error.message)}</div>`;
      return;
    }
    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const roster = rosterData.roster || [];
    listEl.innerHTML = (data || []).map(u => {
      const currentSubRole = u.sub_role || u.role || "inspector";
      const isSelfAdmin = ADMIN_EMAILS.includes(String(u.email || "").toLowerCase());
      const staffOpts = `<option value="">-- 未綁定姓名 --</option>` +
        roster.map(s => `<option value="${esc(s.id)}"${s.id === u.staff_id ? " selected" : ""}>${esc(s.name)}</option>`).join("");
      return `
        <div class="ac-user-row">
          <div>
            <strong>${esc(formatUserDisplay(u.email))}</strong>
            <div style="font-size:10px;color:#6d7b86">${esc(u.email)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <select data-user-role="${esc(u.user_id)}"${isSelfAdmin ? " disabled" : ""}>
              <option value="inspector"${currentSubRole === "inspector" ? " selected" : ""}>檢驗員</option>
              <option value="assistant"${currentSubRole === "assistant" ? " selected" : ""}>助理（僅上傳工作）</option>
              <option value="admin"${currentSubRole === "admin" ? " selected" : ""}>管理員</option>
            </select>
            <select data-user-staff="${esc(u.user_id)}"${currentSubRole === "assistant" ? " disabled" : ""}>
              ${staffOpts}
            </select>
          </div>
        </div>
      `;
    }).join("");
  }

  async function adminCreateUser(rawAccount, password, targetRole = "inspector", staffId = "") {
    if (!isAdmin()) return { error: { message: "僅限管理員建立帳號。" } };
    const cfg = window.APP_SUPABASE_CONFIG;
    if (!cfg?.url || !cfg?.publishableKey || !window.supabase?.createClient) {
      return { error: { message: "Supabase 尚未初始化。" } };
    }
    const email = normalizeAuthEmail(rawAccount);
    if (!email) return { error: { message: "請輸入帳號或 Email。" } };
    if (!password || password.length < 6) return { error: { message: "密碼長度至少需要 6 個字元。" } };

    setAdminMsg("正在建立系統帳號…");
    const tempClient = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: "ac-admin-signup-tmp"
      }
    });
    const res = await tempClient.auth.signUp({ email, password });
    if (res.error) {
      setAdminMsg(`建立帳號失敗：${res.error.message}`, true);
      return { error: res.error };
    }
    if (res.data?.user && Array.isArray(res.data.user.identities) && res.data.user.identities.length === 0) {
      setAdminMsg("此帳號或 Email 已經註冊存在。", true);
      return { error: { message: "此帳號或 Email 已經註冊存在。" } };
    }
    const newUid = res.data?.user?.id;
    if (!newUid) {
      setAdminMsg("建立帳號未取得使用者 ID。", true);
      return { error: { message: "未取得使用者 ID" } };
    }

    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const staffObj = (rosterData.roster || []).find(s => s.id === staffId) || null;
    const roleVal = targetRole === "admin" ? "admin" : "inspector";
    const profRow = {
      user_id: newUid,
      email,
      role: roleVal,
      sub_role: targetRole,
      staff_id: targetRole === "assistant" ? "__assistant__" : (staffId || null),
      staff_name: targetRole === "assistant" ? `助理(${formatUserDisplay(email)})` : (staffObj ? staffObj.name : null),
      updated_at: new Date().toISOString()
    };
    const { error: profErr } = await cloudState.supabase
      .from("user_profiles")
      .upsert(profRow, { onConflict: "user_id" });
    if (profErr) {
      setAdminMsg(`帳號已建立，但寫入角色權限失敗：${profErr.message}`, true);
      return { error: profErr };
    }
    setAdminMsg(`✓ 已建立帳號「${formatUserDisplay(email)}」（可直接登入）。`);
    await refreshAdminUsersList();
    return { error: null, user: res.data.user };
  }

  async function adminUpdateUserRole(userId, nextSubRole, nextStaffId) {
    if (!isAdmin() || !cloudState.supabase || !userId) return { error: { message: "權限不足" } };
    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const staffObj = (rosterData.roster || []).find(s => s.id === nextStaffId) || null;
    const updateObj = {
      role: nextSubRole === "admin" ? "admin" : "inspector",
      sub_role: nextSubRole,
      staff_id: nextSubRole === "assistant" ? "__assistant__" : (nextStaffId || null),
      staff_name: nextSubRole === "assistant" ? "助理專用" : (staffObj ? staffObj.name : null),
      updated_at: new Date().toISOString()
    };
    const { error } = await cloudState.supabase
      .from("user_profiles")
      .update(updateObj)
      .eq("user_id", userId);
    if (error) {
      setAdminMsg(`更新權限失敗：${error.message}`, true);
      return { error };
    }
    setAdminMsg("✓ 已更新帳號角色與對應姓名。");
    await refreshAdminUsersList();
    return { error: null };
  }

  function openModal() {
    const modal = document.getElementById("history-modal");
    if (!modal) return;
    modal.hidden = false;
    updateHeaderAndModalUI();
    if (isLoggedIn()) {
      refreshCloudHistory();
      if (isAdmin()) refreshAdminUsersList();
    }
  }

  function closeModal() {
    const modal = document.getElementById("history-modal");
    if (modal) modal.hidden = true;
  }

  async function performPasswordLogin(emailInputId, passwordInputId, btnId) {
    if (!cloudState.supabase) { setAuthMsg("Supabase 尚未初始化", true); return; }
    const rawAccount = (document.getElementById(emailInputId)?.value || "").trim();
    const password = document.getElementById(passwordInputId)?.value || "";
    const email = normalizeAuthEmail(rawAccount);
    if (!email || !password) { setAuthMsg("請輸入帳號（或 Email）與密碼。", true); return; }

    const btn = document.getElementById(btnId);
    if (btn) btn.disabled = true;
    setAuthMsg("正在驗證登入…");

    const res = await cloudState.supabase.auth.signInWithPassword({ email, password });
    if (btn) btn.disabled = false;
    if (res.error) { setAuthMsg(`登入失敗：${res.error.message}`, true); return; }

    cloudState.user = res.data.user;
    if (document.getElementById(passwordInputId)) document.getElementById(passwordInputId).value = "";
    await onSessionEstablished();
  }

  async function handleMicrosoftLogin() {
    if (!cloudState.supabase) { setAuthMsg("Supabase 尚未初始化", true); return; }
    setAuthMsg("正在前往 Microsoft 登入畫面…");
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await cloudState.supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        redirectTo,
        scopes: "email profile openid"
      }
    });
    if (error) setAuthMsg(`Microsoft 登入失敗：${error.message}`, true);
  }

  async function handleLogout() {
    if (!cloudState.supabase) return;
    const { error } = await cloudState.supabase.auth.signOut();
    if (error) { setAuthMsg(`登出失敗：${error.message}`, true); return; }
    cloudState.user = null;
    cloudState.profile = null;
    cloudState.historyRows = [];
    closeModal();
    updateHeaderAndModalUI();
    renderModalHistoryList([]);
    setAuthMsg("已登出系統，請重新登入。");
    notifyListeners("logout");
  }

  async function onSessionEstablished() {
    await syncUserProfile();
    await pullTeamState();
    updateHeaderAndModalUI();
    await refreshCloudHistory();
    if (isAdmin()) refreshAdminUsersList();
    notifyListeners("login");
  }

  async function initCloud() {
    const cfg = window.APP_SUPABASE_CONFIG;
    if (!cfg?.url || !cfg?.publishableKey || !window.supabase?.createClient) {
      cloudState.ready = true;
      setAuthMsg("雲端 SDK 或設定檔未載入，無法進行認證。", true);
      updateHeaderAndModalUI();
      notifyListeners("init_offline");
      return;
    }

    cloudState.supabase = window.supabase.createClient(cfg.url, cfg.publishableKey);
    const { data, error } = await cloudState.supabase.auth.getSession();
    if (error) {
      cloudState.ready = true;
      setAuthMsg(`Supabase 初始化失敗：${error.message}`, true);
      updateHeaderAndModalUI();
      notifyListeners("init_error");
      return;
    }

    cloudState.user = data.session?.user || null;
    if (cloudState.user && location.hash.includes("access_token=")) {
      history.replaceState(null, "", location.pathname + location.search);
    }

    if (cloudState.user) {
      await onSessionEstablished();
    } else {
      renderModalHistoryList([]);
      setAuthMsg("請輸入系統帳號或使用 Microsoft 帳號登入。");
    }

    cloudState.ready = true;
    updateHeaderAndModalUI();
    notifyListeners("init_done");

    cloudState.supabase.auth.onAuthStateChange(async (event, session) => {
      const prevId = cloudState.user?.id || null;
      const nextUser = session?.user || null;
      cloudState.user = nextUser;
      if (event === "SIGNED_IN" && nextUser && nextUser.id !== prevId) {
        if (location.hash.includes("access_token=")) {
          history.replaceState(null, "", location.pathname + location.search);
        }
        await onSessionEstablished();
      } else if (event === "SIGNED_OUT") {
        cloudState.profile = null;
        cloudState.historyRows = [];
        closeModal();
        updateHeaderAndModalUI();
        renderModalHistoryList([]);
        setAuthMsg("已登出系統，請重新登入。");
        notifyListeners("logout");
      }
    });
  }

  function wireSharedEvents() {
    document.addEventListener("submit", e => {
      if (e.target.id === "ac-gate-form") {
        e.preventDefault();
        performPasswordLogin("ac-gate-email", "ac-gate-password", "ac-gate-login-btn");
      }
    });

    document.addEventListener("click", async e => {
      if (e.target.closest("#nav-history-btn") || e.target.closest("#quick-history-btn")) {
        e.preventDefault();
        openModal();
        return;
      }
      if (e.target.closest("#ac-modal-close") || e.target.id === "history-modal") {
        closeModal();
        return;
      }
      if (e.target.closest("#ac-ms-login") || e.target.closest("#ac-gate-ms-login")) {
        handleMicrosoftLogin();
        return;
      }
      if (e.target.closest("#ac-login")) {
        performPasswordLogin("ac-email", "ac-password", "ac-login");
        return;
      }
      if (e.target.closest("#ac-reg-btn")) {
        const regEmail = document.getElementById("ac-reg-email")?.value || "";
        const regPw = document.getElementById("ac-reg-password")?.value || "";
        const regRole = document.getElementById("ac-reg-role")?.value || "inspector";
        const regStaff = document.getElementById("ac-reg-staff")?.value || "";
        const btn = document.getElementById("ac-reg-btn");
        if (btn) btn.disabled = true;
        const { error } = await adminCreateUser(regEmail, regPw, regRole, regStaff);
        if (btn) btn.disabled = false;
        if (!error) {
          if (document.getElementById("ac-reg-email")) document.getElementById("ac-reg-email").value = "";
          if (document.getElementById("ac-reg-password")) document.getElementById("ac-reg-password").value = "";
        }
        return;
      }
      if (e.target.closest("#ac-logout")) {
        handleLogout();
        return;
      }
      if (e.target.closest("#ac-refresh")) {
        pullTeamState().then(() => refreshCloudHistory());
        return;
      }
      const loadBtn = e.target.closest("button[data-ac-load-date]");
      if (loadBtn) {
        loadCloudDispatch(loadBtn.dataset.acLoadDate, { redirect: true });
      }
    });

    document.addEventListener("change", e => {
      if (e.target.id === "ac-bind-staff") {
        bindMyStaff(e.target.value);
        return;
      }
      if (e.target.id === "ac-reg-role") {
        const staffSel = document.getElementById("ac-reg-staff");
        if (staffSel) {
          staffSel.disabled = e.target.value === "assistant";
          if (e.target.value === "assistant") staffSel.value = "";
        }
        return;
      }
      const roleSel = e.target.closest("select[data-user-role]");
      const staffSel = e.target.closest("select[data-user-staff]");
      if (roleSel || staffSel) {
        const uid = (roleSel || staffSel).dataset.userRole || (roleSel || staffSel).dataset.userStaff;
        const rowEl = (roleSel || staffSel).closest(".ac-user-row");
        const nextRole = rowEl?.querySelector(`select[data-user-role="${uid}"]`)?.value || "inspector";
        const nextStaff = rowEl?.querySelector(`select[data-user-staff="${uid}"]`)?.value || "";
        adminUpdateUserRole(uid, nextRole, nextStaff);
      }
    });

    window.addEventListener("keydown", e => {
      const modal = document.getElementById("history-modal");
      if (e.key === "Escape" && modal && !modal.hidden) closeModal();
    });
  }

  // 對外暴露全站統一 API
  window.AppCloud = {
    ADMIN_EMAIL,
    initReady: null,
    isLoggedIn,
    isAdmin,
    isAssistant,
    isInspector,
    isRestrictedInspector,
    canUploadWork,
    canEditDailyNotes,
    getMyStaffId,
    getMyStaffName,
    bindMyStaff,
    adminCreateUser,
    adminUpdateUserRole,
    getSnapshot,
    openModal,
    closeModal,
    pullTeamState,
    pushTeamStateRoster,
    pushTeamStateDayNotes,
    pushDailyAttendance,
    refreshCloudHistory,
    loadCloudDispatch,
    saveTeamDispatchHistory,
    savePreUploadedWork,
    deleteCloudDispatch,
    getDispatchAssignmentStats,
    isFullyAssigned,
    hasAssignedStaff,
    saveWorkNoteRow,
    addAcceptanceRow,
    deleteAcceptanceRow,
    fetchAcceptanceRecords,
    onChange(cb) {
      cloudState.listeners.add(cb);
      return () => cloudState.listeners.delete(cb);
    }
  };

  function boot() {
    injectSharedStylesAndModal();
    wireSharedEvents();
    updateHeaderAndModalUI();
    const shouldOpenModal = location.hash === "#history";
    window.AppCloud.initReady = initCloud().then(() => {
      if (shouldOpenModal) openModal();
      return getSnapshot();
    });
  }

  if (document.body) {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
