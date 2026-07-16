// Download-page progressive enhancement (TM-331; externalised from an inline <script> in TM-768).
//
// WHY EXTERNAL. The site-wide CSP (TM-722) has no 'unsafe-inline' in script-src, so an inline <script>
// is blocked — under the new CSP this probe silently no-op'd. Served from 'self' it runs again. It
// fails SAFE regardless: the real download is a plain <a download> top-level navigation (not CSP- or
// CORS-gated), so the button always works; this only toggles the cosmetic "not published yet" hint.
//
// The APK lives on a cross-origin GitHub Release (github.com); a cross-origin HEAD can be blocked by
// CORS and reject into .catch(), which is fine — we leave the button enabled so a working APK is never
// hidden. Where CORS allows it, a real 404 still correctly disables the button + reveals the note.
(function () {
  var btn = document.querySelector(".btn");
  var missing = document.getElementById("apk-missing");
  var meta = document.getElementById("apk-meta");
  if (!btn || !missing) return;
  fetch(btn.getAttribute("href"), { method: "HEAD" })
    .then(function (r) {
      if (!r.ok) {
        btn.setAttribute("aria-disabled", "true");
        btn.style.opacity = "0.5";
        btn.style.pointerEvents = "none";
        if (meta) meta.hidden = true;
        missing.hidden = false;
      }
    })
    .catch(function () { /* fail safe — leave the button enabled */ });
})();
