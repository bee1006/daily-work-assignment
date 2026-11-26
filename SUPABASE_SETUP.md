# Supabase 團隊共用雲端、最外層強制登入與帳號控管（V3.3 Microsoft 核准閘門、首次改密與 9 表架構）

本系統採用 **最外層強制登入閘門 + 管理員統一註冊 + 助理專屬上游資料表隔離 + 資料庫列級 RLS 權限控管（RBAC）**。
- 最高使用者（管理員）：`u971503@taipower.com.tw`（測試管理員：`bee1006@gmail.com`）。
- 預留助理帳號：帳號輸入 `guest`（系統自動對應 `guest@taipower.local`）、密碼 `123456`。

---

## 一、執行資料庫與權限 SQL（8 張獨立資料表）

1. 登入您的 Supabase Dashboard ➔ 左側 **SQL Editor**。
2. 開啟專案內的 [supabase-schema.sql](supabase-schema.sql)，將全部內容貼上並點擊 **Run**，會建立輔助函式（`public.is_admin()`、`public.is_assistant()`、`public.my_staff_id()`）、新帳號自動啟用觸發器（`private.auto_confirm_auth_user()`）與以下 8 張資料表：
   - `public.user_profiles`：帳號 Email、角色（`role` / `sub_role`: `admin` / `inspector` / `assistant`）與綁定同仁姓名。
   - `public.staff_roster`（一人一列）：檢驗員名單、監造資格與排序；全體可讀，**僅最高使用者可增刪改**。
   - `public.attendance_records`（日期＋人員一列）：每日出勤狀態；**檢驗員僅能改自己 `staff_id`，助理完全唯讀**。
   - `public.calendar_day_notes`（一日一列）：月曆每日特別任務；全體可讀，**僅最高使用者可修改**。
   - `public.raw_work_uploads`（助理專用上游表，一日一列）：存放助理於「上傳工作」匯入的原始施工清單與座標；全體登入者可讀，**僅助理與最高使用者可寫入**，即使重傳同一天也不會覆蓋主管的指派結果。
   - `public.daily_dispatches`（主管確認後的正式派工表，一日一列）：存放領銜人、指派結果、天氣與公里門檻；全體可讀，**僅最高使用者可寫入／刪除**。
   - `public.daily_work_notes`（日期＋工班一列）：「每日工作」左表備註；**僅最高使用者與檢驗員可改，助理純觀看**。
   - `public.acceptance_records`（一筆一列）：「每日工作」右表與「上傳工作」預登驗收紀錄；**最高使用者與檢驗員可管理全部，助理（`guest`）統一於「上傳工作」頁面新增與移除自己建立的任意日期驗收紀錄，其餘頁面為純觀看**。

---

## 二、帳號登入與管理員統一註冊流程

1. **最外層強制登入**：開啟系統任一頁面時，未登入一律停留在全螢幕登入畫面，不開放訪客瀏覽或公開註冊。
2. **管理員建立新帳號**：僅最高使用者登入後，於右上角「歷史查詢 / 帳號」彈窗可見 **「管理員專屬：帳號註冊與權限管理」**，可建立同仁帳號（輸入簡稱或完整 Email，簡稱自動補上 `@taipower.local`）、設定密碼與指定角色（`檢驗員`／`助理`／`管理員`）。
3. **預留助理帳號**：`guest` / `123456` 已建置於資料庫並自動啟用，可直接登入使用「上傳工作」，切換至其餘頁面皆為唯讀純觀看模式。

---

## 三、啟用公司 Microsoft (Azure Entra ID / M365) 登入與管理員開通流程

本系統支援同仁直接使用公司配發的 Microsoft 帳號登入，同時透過資料庫 `approved` 旗標與 `public.preapproved_users` 白名單強制把關：**任何未經管理員核准開通的 Microsoft 帳號，即使通過微軟認證也無法進入系統或存取任何資料表**。

### 步驟 1：於 Azure Portal（Microsoft Entra ID）建立應用程式
1. 使用管理員帳號登入 [Azure Portal](https://portal.azure.com/#home) ➔ 進入 **Microsoft Entra ID** ➔ **應用程式註冊（App registrations）** ➔ **新增註冊（New registration）**。
2. 輸入名稱（例如 `台電檢驗員派工系統`）。
3. **支援的帳戶類型（Supported account types）**：
   - 若全體同仁皆在同一間公司的 Microsoft 365／Entra ID 組織目錄下，建議選擇 **「僅限此組織目錄中的帳戶（Single tenant）」**（最高安全性）。
   - 若同仁亦使用個人 Microsoft 帳號或跨租戶帳號，可選擇 **「任何組織目錄中的帳戶與個人 Microsoft 帳戶」**（依然會受本系統管理員核准機制攔截）。
4. **重新導向 URI（Redirect URI）**：平台選 **Web**，貼上本專案專用回呼網址：
   ```text
   https://lszdchrnkfkdbovkdbyj.supabase.co/auth/v1/callback
   ```
5. 點擊註冊後，在總覽頁記下 **應用程式 (用戶端) 識別碼（Application (client) ID）** 與 **目錄 (租戶) 識別碼（Directory (tenant) ID）**。
6. 至左側 **憑證與密碼（Certificates & secrets）** ➔ **新增用戶端密碼（New client secret）**，建立後務必複製 **「值（Value）」**（非「密碼識別碼 / Secret ID」）。
7. **設定必要電子郵件聲明（Token Claims）**：至左側 **資訊清單（Manifest）**（或「權杖設定 ➔ 新增選擇性宣告」），確認 ID 權杖與存取權杖包含 `email` 與 `xms_edov` 宣告，確保 Supabase 能取得公司認證後的 Email。

### 步驟 2：於 Supabase Dashboard 設定 Azure Provider 與導向白名單
1. 登入 Supabase Dashboard ➔ **Authentication** ➔ **Providers** ➔ 展開 **Azure**：
   - 開啟 **Azure enabled**。
   - **Azure Client ID**：貼上步驟 1 的 Application (client) ID。
   - **Azure Secret**：貼上步驟 1 的 Client Secret **Value**。
   - **Azure Tenant URL**（建議僅單一公司組織登入時填寫）：`https://login.microsoftonline.com/<您的 Directory (tenant) ID>`（若允許跨租戶則留空或填 `https://login.microsoftonline.com/common`）。
   - 點擊 **Save**。
2. 前往 **Authentication** ➔ **URL Configuration**，設定 **Site URL** 並在 **Redirect URLs** 加入實際使用網址：
   - `https://dispatch.129-203-135-254.nip.io/**`（公司環境網址）
   - `https://bee1006.github.io/**`（若部署於 GitHub Pages）
   - `http://localhost:8000/**`
   - `http://0.0.0.0:8000/**`

### 步驟 3：兩種開通同仁 Microsoft 帳號的方式
管理員登入後點擊右上角 **「歷史查詢／帳號管理」**：
- **方式 A（事先加入白名單 — 推薦）**：於「預先開通公司 Microsoft 帳號」輸入同仁的公司 Microsoft Email，選擇角色（檢驗員／助理／管理員）與綁定同仁姓名，點 **「加入白名單」**。該同仁第一次點擊 Microsoft 登入時即自動核准並綁定進入。
- **方式 B（同仁先登入申請 ➔ 管理員一鍵核准）**：同仁先點「使用公司 Microsoft 帳號登入」，驗證微軟後會停留在 **「⏳ 帳號待管理員核准開通」** 鎖定畫面；管理員於右上角看到紅色 **「🔔 N 待開通」** 提示後，選擇角色與對應姓名並按 **「✓ 核准開通」**，同仁點「重新檢查開通狀態」即可進入系統。
- 管理員亦可隨時點擊已開通帳號旁的 **「停用」**，立即將該帳號退回待審核狀態並封鎖資料庫存取。
