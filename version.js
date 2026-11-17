// 全站統一版本管理、Microsoft/Email 登入、RBAC 權限與 Supabase 團隊雲端同步核心
(function () {
  window.APP_VERSION = "V2.3";
  const ADMIN_EMAIL = "u971503@taipower.com.tw";
  const ADMIN_EMAILS = ["u971503@taipower.com.tw", "bee1006@gmail.com"];
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
    "人手孔及配電場所防水維護作業",
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
        descriptions: [...new Set(team.jobs.map(j => j.workSummary || (j.description || "").split(/\r?\n/)[0]).filter(Boolean))],
        locations: [...new Set(team.jobs.map(j => j.location).filter(Boolean))],
        jobCount: team.jobs.length
      };
    });
  }

  function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (_) { return fallback; }
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
    return cloudState.profile?.role === "admin";
  }

  function isRestrictedInspector() {
    return isLoggedIn() && !isAdmin();
  }

  function getMyStaffId() {
    return cloudState.profile?.staff_id || localStorage.getItem("dispatch-my-staff-id") || "";
  }

  function getMyStaffName() {
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
      isRestrictedInspector: isRestrictedInspector(),
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
        .ac-modal-overlay{position:fixed;inset:0;background:rgba(18,40,56,0.6);backdrop-filter:blur(3px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}
        .ac-modal-overlay[hidden]{display:none!important}
        .ac-modal-card{background:#fff;border-radius:16px;box-shadow:0 24px 48px rgba(0,0,0,0.25);width:100%;max-width:630px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid #dce5e9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif}
        .ac-modal-head{padding:16px 20px;background:#17364c;color:#fff;display:flex;align-items:center;justify-content:space-between}
        .ac-modal-head h3{margin:0;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px}
        .ac-modal-close{background:none;border:0;color:#c6d8df;font-size:22px;cursor:pointer;line-height:1;padding:0 4px}
        .ac-modal-close:hover{color:#fff}
        .ac-modal-body{padding:18px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;color:#172a3a}
        .ac-auth-box{background:#f7fafb;border:1px solid #dce5e9;border-radius:12px;padding:14px}
        .ac-auth-box h4{margin:0 0 10px;font-size:13px;color:#17364c;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
        .ac-ms-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:9px;padding:10px 14px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font:700 13px inherit;cursor:pointer;margin-bottom:10px;transition:.15s;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
        .ac-ms-btn:hover{background:#f8fafc;border-color:#087f78}
        .ac-divider{display:flex;align-items:center;gap:8px;font-size:11px;color:#82909a;margin:8px 0}
        .ac-divider::before,.ac-divider::after{content:"";flex:1;height:1px;background:#e2e8f0}
        .ac-auth-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
        .ac-auth-row input,.ac-auth-row select{min-width:140px;flex:1;border:1px solid #dce5e9;border-radius:7px;padding:8px 10px;font:inherit;font-size:12px;background:#fff;color:#172a3a}
        .ac-btn{border:1px solid #dce5e9;border-radius:7px;padding:8px 12px;background:#fff;color:#17364c;font:700 11px inherit;cursor:pointer;white-space:nowrap}
        .ac-btn.primary{background:#087f78;border-color:#087f78;color:#fff}
        .ac-btn:disabled{opacity:.45;cursor:not-allowed}
        .ac-status{font-size:11px;color:#6d7b86;margin:8px 0 0;line-height:1.5}
        .ac-status.error{color:#b42318}
        .ac-role-badge{font-size:11px;font-weight:800;padding:3px 8px;border-radius:6px}
        .ac-role-admin{background:#fef3c7;color:#92400e;border:1px solid #fde68a}
        .ac-role-inspector{background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe}
        .ac-bind-row{margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
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

    // 確保頁面上只有一個 #history-modal（以統一版取代）
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
              <div class="ac-divider">或使用 Email 密碼登入</div>
              <div class="ac-auth-row">
                <input id="ac-email" type="email" autocomplete="username" placeholder="電子郵件（例：u971503@taipower.com.tw）">
                <input id="ac-password" type="password" autocomplete="current-password" placeholder="密碼">
                <button id="ac-login" class="ac-btn primary" type="button">登入</button>
                <button id="ac-signup" class="ac-btn" type="button">建立帳號</button>
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
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong style="font-size:13px;color:#17364c">團隊雲端歷史派工紀錄</strong>
              <small style="font-size:11px;color:#6d7b86">點擊「讀取並查看」將直接開啟每日工作總表</small>
            </div>
            <div class="ac-history-list" id="ac-history-list">
              <div class="ac-history-empty">尚未登入或正在載入…</div>
            </div>
          </div>
          <div class="ac-notice">
            💡 <strong>角色權限說明：</strong>最高使用者（<code>${esc(ADMIN_EMAIL)}</code>）可管理名單、特別任務與發佈每日派工；一般檢驗員登入後可直接讀取團隊資料、於「每月出勤」點選自己的休假／加班，並於「每日工作」填寫驗收紀錄與備註。
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function setAuthMsg(msg, isError = false) {
    const el = document.getElementById("ac-auth-msg");
    if (el) {
      el.textContent = msg;
      el.classList.toggle("error", isError);
    }
  }

  function populateBindSelect() {
    const sel = document.getElementById("ac-bind-staff");
    if (!sel) return;
    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const roster = rosterData.roster || [];
    const myId = getMyStaffId();
    sel.innerHTML = `<option value="">-- 請選擇您的姓名 --</option>` +
      roster.map(s => `<option value="${esc(s.id)}"${s.id === myId ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  }

  function updateHeaderAndModalUI() {
    document.querySelectorAll(".app-ver-badge").forEach(el => {
      el.textContent = window.APP_VERSION;
    });
    const signedIn = isLoggedIn();
    const admin = isAdmin();
    const myName = getMyStaffName();

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
        navBtn.title = `最高使用者：${cloudState.user.email}`;
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
    if (inputs) inputs.hidden = signedIn;
    if (logged) logged.hidden = !signedIn;
    if (statusEl) statusEl.textContent = signedIn ? "已連線登入" : "尚未登入";
    if (signedIn && emailLabel) emailLabel.textContent = cloudState.user.email || "";
    if (signedIn && roleBadge) {
      roleBadge.textContent = admin ? "👑 最高使用者" : "👤 一般檢驗員";
      roleBadge.className = "ac-role-badge " + (admin ? "ac-role-admin" : "ac-role-inspector");
    }
    if (bindRow) bindRow.hidden = !signedIn;
    populateBindSelect();
  }

  async function syncUserProfile() {
    if (!cloudState.supabase || !cloudState.user) {
      cloudState.profile = null;
      return;
    }
    const uid = cloudState.user.id;
    const email = String(cloudState.user.email || "").trim();
    const isAdminEmail = ADMIN_EMAILS.includes(email.toLowerCase());

    const { data: existing } = await cloudState.supabase
      .from("user_profiles")
      .select("user_id,email,role,staff_id,staff_name")
      .eq("user_id", uid)
      .maybeSingle();

    if (existing) {
      let nextRole = existing.role;
      if (isAdminEmail && existing.role !== "admin") {
        nextRole = "admin";
        await cloudState.supabase.from("user_profiles").update({ role: "admin", updated_at: new Date().toISOString() }).eq("user_id", uid);
      }
      cloudState.profile = { ...existing, role: nextRole };
      if (existing.staff_id) {
        localStorage.setItem("dispatch-my-staff-id", existing.staff_id);
      }
    } else {
      let guessedStaffId = localStorage.getItem("dispatch-my-staff-id") || null;
      let guessedStaffName = null;
      const metaName = cloudState.user.user_metadata?.full_name || cloudState.user.user_metadata?.name || "";
      if (!guessedStaffId && metaName) {
        const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
        const matched = (rosterData.roster || []).find(s => metaName.includes(s.name) || s.name.includes(metaName));
        if (matched) {
          guessedStaffId = matched.id;
          guessedStaffName = matched.name;
          localStorage.setItem("dispatch-my-staff-id", matched.id);
        }
      }
      const newProf = {
        user_id: uid,
        email,
        role: isAdminEmail ? "admin" : "inspector",
        staff_id: guessedStaffId,
        staff_name: guessedStaffName,
        updated_at: new Date().toISOString()
      };
      const { error } = await cloudState.supabase.from("user_profiles").upsert(newProf, { onConflict: "user_id" });
      cloudState.profile = error ? { role: isAdminEmail ? "admin" : "inspector", email, staff_id: guessedStaffId } : newProf;
    }
  }

  async function bindMyStaff(staffId) {
    const rosterData = loadJson("dispatch-roster-v2", { roster: [] });
    const staff = (rosterData.roster || []).find(s => s.id === staffId) || null;
    if (staffId) localStorage.setItem("dispatch-my-staff-id", staffId);
    else localStorage.removeItem("dispatch-my-staff-id");

    if (cloudState.supabase && cloudState.user) {
      await cloudState.supabase.from("user_profiles").upsert({
        user_id: cloudState.user.id,
        email: cloudState.user.email || "",
        role: isAdmin() ? "admin" : "inspector",
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
    const [rosterRes, attRes, notesRes] = await Promise.all([
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
        .select("work_date,note")
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
      localStorage.setItem("dispatch-roster-v2", JSON.stringify({ roster: nextRoster, daily: nextDaily }));
      changed = true;
    }
    if ((notesRes.data || []).length || Object.keys(cloudDayNotes).length) {
      localStorage.setItem("dispatch-day-notes-v1", JSON.stringify(cloudDayNotes));
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
        localStorage.setItem("dispatch-acceptance-v1", JSON.stringify(am));
      }
    }

    return { error: null };
  }

  function renderModalHistoryList(rows = []) {
    const list = document.getElementById("ac-history-list");
    if (!list) return;
    if (!isLoggedIn()) {
      list.innerHTML = '<div class="ac-history-empty">請先在上方登入 Microsoft 或 Email 帳號，以讀取團隊雲端派工紀錄。</div>';
      return;
    }
    if (!rows.length) {
      list.innerHTML = '<div class="ac-history-empty">目前雲端尚無已儲存的派工紀錄。</div>';
      return;
    }
    list.innerHTML = rows.map(row => {
      const jobsCount = row.payload?.jobs?.length || 0;
      const crewCount = row.payload?.assignments ? Object.keys(row.payload.assignments).length : 0;
      const timeStr = new Date(row.updated_at).toLocaleString("zh-TW", { hour12: false });
      return `
        <div class="ac-history-item">
          <div>
            <div class="ac-history-date">${esc(rocDate(row.work_date))} <span class="ac-history-badge">已排工</span></div>
            <div class="ac-history-meta">更新：${esc(timeStr)}${jobsCount ? ` · ${jobsCount} 筆案件` : ""}${crewCount ? ` · ${crewCount} 組工作` : ""}</div>
          </div>
          <button class="ac-btn primary" type="button" data-ac-load-date="${esc(row.work_date)}">讀取並查看</button>
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
    const { data, error } = await cloudState.supabase
      .from("daily_dispatches")
      .select("work_date,first_staff,filename,weather,jobs,assignments,updated_at")
      .order("work_date", { ascending: false });

    if (error) {
      setAuthMsg(`讀取歷史紀錄失敗：${error.message}。請確認已在 Supabase 建立正規化資料表。`, true);
      if (listEl) listEl.innerHTML = `<div class="ac-history-empty" style="color:#b42318">讀取失敗：${esc(error.message)}</div>`;
      return [];
    }

    const mapped = (data || []).map(row => ({
      work_date: row.work_date,
      first_staff: row.first_staff,
      updated_at: row.updated_at,
      payload: {
        filename: row.filename || "",
        weather: row.weather || "晴",
        jobs: row.jobs || [],
        assignments: row.assignments || {}
      }
    }));
    cloudState.historyRows = mapped;
    renderModalHistoryList(mapped);
    setAuthMsg(`已登入 ${cloudState.user.email}（${isAdmin() ? "最高使用者" : "檢驗員"}），雲端共有 ${mapped.length} 筆每日紀錄。`);
    notifyListeners("history_updated");
    return mapped;
  }

  async function loadCloudDispatch(workDate, options = {}) {
    if (!cloudState.supabase || !cloudState.user || !workDate) return null;
    setAuthMsg(`正在讀取 ${rocDate(workDate)} 雲端派工紀錄…`);

    const [dispRes, notesRes, accRes, attRes] = await Promise.all([
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
        .select("id,zone,batch,staff_name,note,created_at")
        .eq("work_date", workDate)
        .order("created_at", { ascending: true }),
      cloudState.supabase
        .from("attendance_records")
        .select("staff_id,status_type,attending,noncritical,note")
        .eq("work_date", workDate)
    ]);

    if (dispRes.error || !dispRes.data) {
      setAuthMsg(`讀取失敗：${dispRes.error?.message || "找不到該日紀錄"}`, true);
      return null;
    }

    const dispatch = dispRes.data;
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
    localStorage.setItem("dispatch-roster-v2", JSON.stringify({ roster: mergedRoster, daily: mergedDaily }));

    const existingManual = loadJson("dispatch-manual-v1", {});
    existingManual[workDate] = dispatch.manual_assignments || {};
    localStorage.setItem("dispatch-manual-v1", JSON.stringify(existingManual));

    const wm = loadJson("dispatch-weather-v1", {});
    wm[workDate] = dispatch.weather || "晴";
    localStorage.setItem("dispatch-weather-v1", JSON.stringify(wm));

    const am = loadJson("dispatch-acceptance-v1", {});
    am[workDate] = (accRes.data || []).map(r => ({
      id: r.id,
      zone: r.zone,
      batch: r.batch || "",
      staff: r.staff_name || "",
      note: r.note || ""
    }));
    localStorage.setItem("dispatch-acceptance-v1", JSON.stringify(am));

    const wn = loadJson("dispatch-work-notes-v1", {});
    const dayWorkNotes = {};
    for (const r of (notesRes.data || [])) {
      if (r.note) dayWorkNotes[r.team_key] = r.note;
    }
    wn[workDate] = dayWorkNotes;
    localStorage.setItem("dispatch-work-notes-v1", JSON.stringify(wn));

    const payloadShape = {
      filename: dispatch.filename || "雲端歷史紀錄",
      jobs: dispatch.jobs || [],
      assignments: dispatch.assignments || {},
      roster: mergedRoster,
      proximityKm: Number(dispatch.proximity_km) || 10,
      coordinates: dispatch.coordinates || { matched: 0, decoded: 0, total: 0, available: false }
    };

    // 重建 daily.html 所需的 dispatch-daily-work-v1 與 dispatch-session-cache-v1
    const allDailyWork = loadJson("dispatch-daily-work-v1", {});
    allDailyWork[workDate] = {
      date: workDate,
      filename: payloadShape.filename,
      firstStaff: dispatch.first_staff || "",
      updatedAt: dispatch.updated_at || new Date().toISOString(),
      items: buildDailyWorkItemsFromPayload(payloadShape, mergedRoster)
    };
    localStorage.setItem("dispatch-daily-work-v1", JSON.stringify(allDailyWork));

    const allCache = loadJson("dispatch-session-cache-v1", {});
    allCache[workDate] = {
      date: workDate,
      filename: payloadShape.filename,
      firstStaff: dispatch.first_staff || "",
      proximityKm: payloadShape.proximityKm,
      coordinates: payloadShape.coordinates,
      jobs: payloadShape.jobs,
      assignments: payloadShape.assignments
    };
    localStorage.setItem("dispatch-session-cache-v1", JSON.stringify(allCache));
    localStorage.setItem("dispatch-active-date-v1", workDate);

    closeModal();
    if (options.redirect !== false) {
      location.href = `daily.html?date=${encodeURIComponent(workDate)}`;
    } else {
      notifyListeners("dispatch_loaded");
    }
    return {
      work_date: dispatch.work_date,
      first_staff: dispatch.first_staff,
      updated_at: dispatch.updated_at,
      payload: payloadShape
    };
  }

  function openModal() {
    const modal = document.getElementById("history-modal");
    if (!modal) return;
    modal.hidden = false;
    updateHeaderAndModalUI();
    if (isLoggedIn()) refreshCloudHistory();
  }

  function closeModal() {
    const modal = document.getElementById("history-modal");
    if (modal) modal.hidden = true;
  }

  async function handleEmailAuth(createAccount) {
    if (!cloudState.supabase) { setAuthMsg("Supabase 尚未初始化", true); return; }
    const email = (document.getElementById("ac-email")?.value || "").trim();
    const password = document.getElementById("ac-password")?.value || "";
    if (!email || !password) { setAuthMsg("請輸入電子郵件與密碼。", true); return; }

    const btn = document.getElementById(createAccount ? "ac-signup" : "ac-login");
    if (btn) btn.disabled = true;
    setAuthMsg(createAccount ? "正在建立帳號…" : "正在登入…");

    const res = createAccount
      ? await cloudState.supabase.auth.signUp({ email, password })
      : await cloudState.supabase.auth.signInWithPassword({ email, password });

    if (btn) btn.disabled = false;
    if (res.error) { setAuthMsg(res.error.message, true); return; }
    if (createAccount && !res.data.session) {
      setAuthMsg("帳號已建立，請先至信箱完成驗證後再登入。");
      return;
    }
    cloudState.user = res.data.user;
    if (document.getElementById("ac-password")) document.getElementById("ac-password").value = "";
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
    updateHeaderAndModalUI();
    renderModalHistoryList([]);
    setAuthMsg("已登出雲端帳號。");
    notifyListeners("logout");
  }

  async function onSessionEstablished() {
    await syncUserProfile();
    await pullTeamState();
    updateHeaderAndModalUI();
    await refreshCloudHistory();
    notifyListeners("login");
  }

  async function initCloud() {
    const cfg = window.APP_SUPABASE_CONFIG;
    if (!cfg?.url || !cfg?.publishableKey || !window.supabase?.createClient) {
      cloudState.ready = true;
      setAuthMsg("雲端 SDK 或設定檔未載入，目前使用本機模式。", true);
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
      updateHeaderAndModalUI();
      renderModalHistoryList([]);
      setAuthMsg("請使用 Microsoft 或 Email 帳號登入，以讀取團隊雲端資料。");
    }

    cloudState.ready = true;
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
        updateHeaderAndModalUI();
        renderModalHistoryList([]);
        setAuthMsg("已登出雲端帳號。");
        notifyListeners("logout");
      }
    });
  }

  function wireSharedEvents() {
    document.addEventListener("click", e => {
      if (e.target.closest("#nav-history-btn") || e.target.closest("#quick-history-btn")) {
        e.preventDefault();
        openModal();
        return;
      }
      if (e.target.closest("#ac-modal-close") || e.target.id === "history-modal") {
        closeModal();
        return;
      }
      if (e.target.closest("#ac-ms-login")) {
        handleMicrosoftLogin();
        return;
      }
      if (e.target.closest("#ac-login")) {
        handleEmailAuth(false);
        return;
      }
      if (e.target.closest("#ac-signup")) {
        handleEmailAuth(true);
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
    isRestrictedInspector,
    getMyStaffId,
    getMyStaffName,
    bindMyStaff,
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
    saveWorkNoteRow,
    addAcceptanceRow,
    deleteAcceptanceRow,
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
