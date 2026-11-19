# Supabase 團隊共用雲端、最外層強制登入與帳號控管（V3.0 正規化 8 表架構）

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

## 三、設定網址白名單與 Microsoft (Azure) OAuth（選擇性）

1. 在 Supabase Dashboard ➔ **Authentication** ➔ **URL Configuration** 加入網站網址（例如 `http://localhost:8000/**`、`http://0.0.0.0:8000/**`）。
2. 若要啟用 Microsoft 一鍵登入，請於 Azure Portal 建立應用程式並將 Client ID / Secret 填入 **Authentication** ➔ **Providers** ➔ **Azure**。
