// Help page (TM-255) — the static #/help guide. A framework-free, theme-token-styled view that
// explains the basics so a user can self-serve without asking: how to sign in (the three ways),
// editing your profile, what TeamMarhaba is, and where to get support.
//
// Mounting mirrors the other view modules (profile.js / onboarding.js / admin.js): the router
// (TM-109) owns #help-view visibility and calls enterHelp() on entry; this module builds the
// content into that container once and is idempotent on re-entry. Reachable signed-in OR signed-out
// (the nav link is always shown) — the content is static, so there's nothing to gate.
//
// XSS-safety is inherited from the UX kit (TM-133): every node is built with `el()` (textContent
// only, no innerHTML seam), so the copy below can never inject markup. Styling is purely via theme
// tokens (see .help-* rules in styles.css), so it renders correctly under clean / doodle / sketch
// and at phone widths + inside the Android WebView.

import { clear, el } from "./ui.js";

const $ = (id) => document.getElementById(id);

// Support contact. Lives on the 10xai.co.uk domain (same as the email-code sender + the TM-254
// byline). A plain mailto: — no backend, no new deps.
const SUPPORT_EMAIL = "hello@10xai.co.uk";

/** Build a titled help section: an <h3> heading followed by its body nodes. */
function section(title, ...body) {
  return el("section", { class: "help-section" }, [el("h3", { text: title }), ...body]);
}

/** A simple <p>. */
function p(...children) {
  return el("p", {}, children);
}

/** Build the (idempotent) help content into the view container. */
function build(view) {
  const supportLink = el(
    "a",
    { href: `mailto:${SUPPORT_EMAIL}`, class: "help-support-link" },
    SUPPORT_EMAIL,
  );

  clear(view).append(
    el("div", { class: "help-card" }, [
      el("h2", { text: "Help" }),
      el("p", {
        class: "help-intro",
        text: "Everything you need to get started with TeamMarhaba.",
      }),

      section(
        "What is TeamMarhaba?",
        p(
          "TeamMarhaba is a social meetup app — it helps you find people nearby, organise get-togethers, " +
            "and keep the plans (and the chat) in one place. Sign in, set up your profile, and you're ready to go.",
        ),
      ),

      section(
        "Signing in",
        p("There are three ways to sign in. The quickest is the default — no password to remember:"),
        el("ul", { class: "help-list" }, [
          el("li", {}, [
            el("strong", { text: "Email code (default). " }),
            "Enter your email and tap ",
            el("em", { text: "“Email me a code”" }),
            ". We'll email you a 6-digit code — type it in to finish signing in. The code expires " +
              "shortly and can only be used once.",
          ]),
          el("li", {}, [
            el("strong", { text: "Text message (SMS). " }),
            "Tap ",
            el("em", { text: "“Try another way”" }),
            " on the sign-in screen, then enter your phone number (with country code) under " +
              "“Text me a code”. We'll text you a 6-digit code to sign in.",
          ]),
          el("li", {}, [
            el("strong", { text: "Email and password. " }),
            "Also under ",
            el("em", { text: "“Try another way”" }),
            ": enter your password to sign in, or create an account with ",
            el("em", { text: "“Sign up”" }),
            ".",
          ]),
        ]),
      ),

      section(
        "Editing your profile",
        p(
          "Once you're signed in, open ",
          el("strong", { text: "Profile" }),
          " from the menu to update your details — name, city, age, phone, time zone, and how you'd " +
            "like to be notified. You can also set a profile photo. Tap ",
          el("em", { text: "“Save changes”" }),
          " to keep them.",
        ),
      ),

      section(
        "Get support",
        p(
          "Stuck or spotted something wrong? Email us at ",
          supportLink,
          " and we'll help you out.",
        ),
      ),
    ]),
  );
}

/**
 * Called by the router when the #/help view becomes active. Builds the content once (idempotent on
 * re-entry) — there's no per-visit data to load, so this is purely static.
 */
export function enterHelp() {
  const view = $("help-view");
  if (!view) return;
  if (!view.dataset.built) {
    build(view);
    view.dataset.built = "true";
  }
}

// Bridge for ad-hoc use / parity with the other view modules.
if (typeof window !== "undefined") {
  window.tmHelp = { enterHelp };
}
