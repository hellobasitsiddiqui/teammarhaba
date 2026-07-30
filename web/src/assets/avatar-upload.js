// TM-684 — a small, reusable AVATAR UPLOADER: a centred, clickable circular control that reuses the
// EXACT same upload path as the profile avatar (profile.js buildAvatar) without depending on any of
// profile.js's module state. Built for the onboarding gate, where a photo is OPTIONAL (it replaces the
// old disabled "Soon" stub); any surface wanting the stacked circular style can reuse it.
//
// Single source of truth = the Firebase user's `photoURL` (set by storage.uploadAvatar), exactly like
// the profile control — we persist nothing avatar-related ourselves. After a successful upload we fire
// ONE `announceAvatarChanged()` (TM-846) so every avatar surface (this preview, the profile hub, the
// identity header + strength %) repaints without a reload.
import { el, toast } from "./ui.js";
import { currentUser } from "./auth.js";
import { announceAvatarChanged } from "./avatar-events.js";
import { isStorageConfigured, uploadAvatar, validateAvatarFile, MAX_AVATAR_BYTES } from "./storage.js";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Tiny local SVG builder (onboarding.js has its own; this keeps the module self-contained). */
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) node.appendChild(c);
  return node;
}

/** The same camera-outline glyph the TM-684 stub used, so the empty state stays visually identical. */
function cameraGlyph() {
  return svg(
    "svg",
    {
      class: "tm-avatar-cam", viewBox: "0 0 24 24", width: 34, height: 34, fill: "none",
      stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true", focusable: "false",
    },
    [
      svg("path", { d: "M4 8.5h3l1.4-2h7.2L20 8.5h.5A1.5 1.5 0 0 1 22 10v8a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 18v-8A1.5 1.5 0 0 1 3.5 8.5" }),
      svg("circle", { cx: 12, cy: 13.6, r: 3.5 }),
    ],
  );
}

/**
 * Build the avatar uploader.
 *
 * @param {{idPrefix?: string}} [opts] idPrefix scopes the DOM ids so more than one uploader can coexist.
 * @returns {{wrapper: HTMLElement, refresh: () => void}} `refresh()` repaints the preview from the live
 *   photoURL (call it if the avatar changes elsewhere).
 */
export function buildAvatarUploader({ idPrefix = "avatar" } = {}) {
  const configured = isStorageConfigured();
  const fileId = `${idPrefix}-file`;
  const errorId = `${idPrefix}-error`;
  const hintId = `${idPrefix}-hint`;

  const image = el("img", { class: "tm-avatar-img", alt: "", hidden: true });
  const placeholder = cameraGlyph();

  // The circle IS the click target: a <label> pointed at the (visually-hidden but focusable) file input,
  // so both pointer and keyboard users open the OS picker (which offers camera + gallery on mobile).
  const ring = el("label", { class: "tm-avatar-stub tm-avatar-pick", for: fileId }, [image, placeholder]);

  const fileInput = el("input", {
    id: fileId,
    class: "tm-avatar-file tm-avatar-file-hidden",
    type: "file",
    accept: "image/*",
    "aria-describedby": `${errorId} ${hintId}`,
    disabled: !configured,
  });

  const label = el("span", { class: "tm-avatar-uploader-label", text: "Add a photo" });

  const progressBar = el("div", { class: "tm-avatar-progress-bar" });
  const progress = el(
    "div",
    { class: "tm-avatar-progress", role: "progressbar", "aria-label": "Upload progress", "aria-valuemin": "0", "aria-valuemax": "100", hidden: true },
    [progressBar],
  );

  const mb = Math.round(MAX_AVATAR_BYTES / (1024 * 1024));
  const hint = el("p", {
    id: hintId,
    class: "tm-muted tm-avatar-note",
    text: configured ? `Optional — JPG, PNG or GIF, up to ${mb} MB.` : "Photo uploads aren't available in this environment yet.",
  });
  const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });

  /** Paint the preview from the live Firebase photoURL (image if present, else the camera placeholder). */
  const refresh = () => {
    const url = currentUser()?.photoURL || "";
    if (url) {
      image.src = url; // assigning .src is XSS-safe (no markup parse) — never innerHTML.
      image.hidden = false;
      placeholder.style.display = "none";
      ring.classList.add("tm-avatar-has-photo");
      label.textContent = "Change photo";
    } else {
      image.removeAttribute("src");
      image.hidden = true;
      placeholder.style.display = "";
      ring.classList.remove("tm-avatar-has-photo");
      label.textContent = "Add a photo";
    }
  };

  const setError = (msg) => { error.textContent = msg || ""; error.hidden = !msg; };
  const setProgress = (fraction) => {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    progress.hidden = false;
    progressBar.style.width = `${pct}%`;
    progress.setAttribute("aria-valuenow", String(pct));
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    setError("");

    // Fail fast on the client (mirrors the Storage rules) before any network round-trip.
    const invalid = validateAvatarFile(file);
    if (invalid) {
      setError(invalid);
      toast(invalid, { type: "error" });
      fileInput.value = "";
      return;
    }

    fileInput.disabled = true;
    setProgress(0);
    try {
      await uploadAvatar(file, setProgress); // sets Firebase photoURL — the single source of truth.
      announceAvatarChanged(); // TM-846: ONE broadcast repaints every avatar surface.
      refresh();
      toast("Photo added.", { type: "success" });
    } catch (err) {
      const msg = err?.message || "Couldn't upload your photo.";
      setError(msg);
      toast(msg, { type: "error" });
    } finally {
      fileInput.disabled = false;
      progress.hidden = true;
      progressBar.style.width = "0%";
      fileInput.value = ""; // allow re-picking the same file after success or error.
    }
  });

  refresh();

  // Input BEFORE the ring so `:focus-visible + .tm-avatar-pick` can show a keyboard focus ring on the
  // circle (the input itself is visually hidden). The section is a flex column; the absolutely-positioned
  // input is out of flow, so DOM order here doesn't affect the visual stack.
  const wrapper = el("section", { class: "tm-avatar-uploader", "aria-label": "Profile photo" }, [
    fileInput,
    ring,
    label,
    progress,
    hint,
    error,
  ]);
  return { wrapper, refresh };
}
