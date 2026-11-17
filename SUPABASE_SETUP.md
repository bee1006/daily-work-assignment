# Supabase 團隊共用雲端與 Microsoft 登入設定（V2.3 正規化 7 表架構）

本系統採用 **正規化分表儲存 + 資料庫列級 RLS 權限控管（RBAC）**，支援 **Microsoft (Azure) 帳號一鍵登入** 及 **Email 帳密登入**。
最高使用者（管理員）：`u971503@taipower.com.tw`（測試管理員：`bee1006@gmail.com`）。

---

## 一、執行資料庫與權限 SQL（7 張獨立資料表）

1. 登入您的 Supabase Dashboard ➔ 左側 **SQL Editor**。
2. 開啟專案內的 [supabase-schema.sql](supabase-schema.sql)，將全部內容貼上並點擊 **Run**，會建立 2 個輔助函式（`public.is_admin()`、`public.my_staff_id()`）與以下 7 張資料表：
   - `public.user_profiles`：使用者 Email、角色（`admin` / `inspector`）與綁定的同仁 `staff_id` / `staff_name`。
   - `public.staff_roster`（一人一列）：檢驗員名單、監造資格與排序；全體可讀，**僅最高使用者可增刪改**。
   - `public.attendance_records`（日期＋人員一列）：每日出勤狀態、非核心／驗收標記與個人備註；**一般檢驗員在資料庫 RLS 層級直接限制為僅能新增／修改自己 `staff_id` 的紀錄**，多人同時點選不互相覆蓋。
   - `public.calendar_day_notes`（一日一列）：月曆每日特別任務；全體可讀，**僅最高使用者可修改**。
   - `public.daily_dispatches`（一日一列）：每日派工主表（領銜人、天氣、公里限制、案件列表、指派結果）；全體可讀，**僅最高使用者可寫入／改派**。
   - `public.daily_work_notes`（日期＋工班一列）：「每日工作」左表各列備註；團隊成員皆可針對單一工班列獨立更新。
   - `public.acceptance_records`（一筆一列）：「每日工作」右表檢驗員驗收紀錄；新增或刪除單筆即直接寫入或刪除該列。

---

## 二、設定網址白名單（Redirect URLs）

1. 在 Supabase Dashboard ➔ **Authentication** ➔ **URL Configuration**。
2. 在 **Site URL** 與 **Redirect URLs** 加入您的使用網址，例如：
   - 本機開發測試：`http://127.0.0.1:8000/**`、`http://0.0.0.0:8000/**`、`http://localhost:8000/**`
   - 區域網路連線：`http://192.168.0.134:8000/**`（依 Mac mini 實際 IP）

---

## 三、設定 Microsoft (Azure) OAuth 一鍵登入

若要讓同仁直接點「使用 Microsoft 帳號登入」：

1. 前往 [Microsoft Azure Portal](https://portal.azure.com/) ➔ 搜尋並進入 **App registrations（應用程式註冊）** ➔ **New registration**。
   - **Name**：填寫 `台電檢驗員派工系統`（自訂）。
   - **Supported account types**：依同仁使用的帳號類型選擇（若包含公司 M365 與個人 Outlook/OneDrive 帳號，請選 **Accounts in any organizational directory and personal Microsoft accounts**）。
   - **Redirect URI**：平台選 **Web**，網址填入您 Supabase 專案的回呼網址：
     `https://<您的-Supabase-Project-ID>.supabase.co/auth/v1/callback`
2. 註冊完成後：
   - 記下 **Application (client) ID**。
   - 進入左側 **Certificates & secrets** ➔ **New client secret** ➔ 記下產生的 **Value**（祕密值，注意不要複製成 Secret ID）。
3. 回到 Supabase Dashboard ➔ **Authentication** ➔ **Providers** ➔ 找到 **Azure (Microsoft)** 並開啟：
   - **Azure Client ID**：填入剛才的 Application (client) ID。
   - **Azure Secret**：填入剛才產生的 Client Secret Value。
   - **Azure Tenant URL**：若限特定組織可填，若允許一般/個人微軟帳號則留空或依預設即可。
   - 點擊 **Save** 儲存。

---

## 四、角色權限說明（RBAC）

- **最高使用者（管理員 `u971503@taipower.com.tw`）**：
  - 可編輯「每月出勤」全員狀態、雙擊編輯每日特別任務、管理同仁名單增刪與資格。
  - 可在「派工任務」上傳 Excel、自動／手動派工並儲存至雲端。
  - 可在「每日工作」修改檢驗員指派、填寫備註、管理驗收紀錄並同步至雲端。
- **一般同仁（檢驗員）**：
  - 登入後於彈窗「對應同仁姓名」綁定自己的姓名，並由 `user_profiles` 寫入資料庫作為 RLS 驗證依據。
  - **每月出勤**：僅可修改「自己本人」的休假／假日加班／驗收狀態與個人備註；無法更動他人、特別任務與人員名單。
  - **每日工作**：左表檢驗員指派為唯讀，可即時編輯左表單列「備註」（`daily_work_notes`）與即時新增／刪除右表「檢驗員驗收紀錄」（`acceptance_records`）。
  - **派工任務**：唯讀檢視當日派工卡片與建議路線。
