// Register the read-stats snapshot Service Worker. Failure is silent —
// a broken SW registration must never break the site. See sw.js for
// scope and freshness policy.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
