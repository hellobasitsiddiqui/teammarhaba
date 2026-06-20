// Minimal client script for the walking-skeleton web surface.
// No business logic — just proves the static bundle loads and runs.
document.addEventListener("DOMContentLoaded", () => {
    const status = document.getElementById("status");
    if (status) {
        status.textContent = "web surface ready";
    }
});
