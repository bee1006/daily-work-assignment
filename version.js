// 統一管理全站系統版本號與雲端連線燈號
window.APP_VERSION = "V2.2";
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".app-ver-badge").forEach(el => {
    el.textContent = window.APP_VERSION;
  });
  try {
    const hasSession = Object.keys(localStorage).some(k => k.startsWith("sb-") && k.endsWith("-auth-token") && localStorage.getItem(k));
    if (hasSession) {
      document.querySelectorAll(".cloud-dot").forEach(dot => dot.classList.add("connected"));
    }
  } catch (_) {}
});
