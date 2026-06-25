// Minimal client script for the landing surface.
// No business logic — just proves the static bundle loads and runs, and clears the
// "loading…" placeholder once it does (TM-296: no dev placeholder copy left on screen).
document.addEventListener("DOMContentLoaded", () => {
    const status = document.getElementById("status");
    if (status) {
        status.textContent = "Ready when you are.";
    }
});
