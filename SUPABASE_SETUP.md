# Supabase 內網測試準備

派工頁面已加入 Supabase 登入、每日紀錄儲存與歷史載入。請先套用資料表 SQL，才能實際使用雲端功能。Excel 原始檔仍只在 Mac mini 本機解析；按「儲存今日派工到雲端」時，才會把該日解析後的案件、出勤、輪替起點與派工結果送到 Supabase。

## 先在 Supabase 建立專案

1. 建立 Supabase project，選擇適合公司資料要求的地區與密碼。
2. 在 Project Settings > API Keys 找到 Project URL 與 **Publishable key**（舊專案可能顯示 `anon` key）。
3. Mac mini 網站資料夾的 `supabase-config.js` 已放入連線設定，且列入 `.gitignore`，不會隨 Git 提交。同步新版時，請保留這個檔案。
4. 在 Supabase SQL Editor 執行 `supabase-schema.sql`。資料表啟用 RLS，只有登入後的使用者能讀寫自己的紀錄。
5. Supabase Authentication 的 URL Configuration，將 Mac mini 網站網址加入 Redirect URLs，例如 `http://192.168.0.134:8000/**`；若使用 `127.0.0.1` 測試，也要加入對應網址。

不要把 `secret` 或 `service_role` key 放入任何前端檔案，也不要把它貼到聊天或提交到 GitHub。前端使用的 publishable/anon key 本來就會被瀏覽器看見，資料安全必須由 Supabase Auth 與 RLS 規則保護。

## 現階段限制

派工頁面以 `@supabase/supabase-js` CDN 版連線，不需要 Next.js、`@supabase/ssr` 或 npm build。登入後，同一位使用者同一天的儲存會更新該日最新版本；歷史選單可載入已儲存日期。尚未執行 SQL 前，登入可成功，但讀取／儲存會回報資料表未就緒。

Mac mini 上的 `supabase-config.js` 被 Git 忽略，更新程式碼時不會自動同步該檔。Publishable key 可用於前端，但安全性依賴 Auth 與 RLS；絕不可改放 Secret 或 service_role key。
