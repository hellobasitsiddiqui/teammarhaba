// Route guard + auth-aware nav (TM-109 / 2.2.5) — framework-free.
//
// Gates protected routes behind sign-in and drives the top nav from auth state. Path-based,
// matching the API client's convention (api.js → /login?redirect=<path>), so a 401-driven
// redirect and a direct deep link behave the same. Full-page navigation is fine: Firebase
// persistence (auth.js) keeps the user signed in across the reload.
//
// This cooperates with login.js (which shows the sign-in form vs the signed-in "home" card on
// auth state) — guard.js owns the URL/redirect + nav; login.js owns which card is visible.
//
// IMPORTANT: the client guard is UX only. The real gate is the backend's default-deny (TM-79);
// the API rejects an unauthenticated caller regardless of what the browser shows.
import { onAuthChanged, signOut } from "./auth.js";
import { LOGIN_PATH } from "./api.js";

const HOME_PATH = "/";

const fullPath = () => window.location.pathname + window.location.search;
const onLoginRoute = () => window.location.pathname === LOGIN_PATH;
const redirectTarget = () => new URLSearchParams(window.location.search).get("redirect");

// Only same-origin absolute paths — never an absolute URL or protocol-relative `//host`,
// so a crafted `?redirect=` can't become an open redirect.
function safePath(path, fallback) {
  return path && path.startsWith("/") && !path.startsWith("//") ? path : fallback;
}

function navigate(path) {
  if (fullPath() !== path) window.location.assign(path);
}

// Top nav reflects auth state: user label + Sign out when signed in, a Sign in link when out.
function renderNav(user) {
  const signedIn = Boolean(user);
  const navUser = document.getElementById("nav-user");
  const navSignOut = document.getElementById("nav-signout");
  const navSignIn = document.getElementById("nav-signin");
  if (navUser) navUser.textContent = signedIn ? user.email ?? user.uid : "";
  if (navSignOut) navSignOut.hidden = !signedIn;
  if (navSignIn) navSignIn.hidden = signedIn;
}

document.getElementById("nav-signout")?.addEventListener("click", () => signOut());

// Runs on every auth-state resolution, including the first one on page load.
onAuthChanged((user) => {
  renderNav(user);
  if (user) {
    // Signed in on the login screen → return to where they were headed.
    if (onLoginRoute()) navigate(safePath(redirectTarget(), HOME_PATH));
  } else if (!onLoginRoute()) {
    // Signed out on a protected route → login, remembering the intended target.
    navigate(`${LOGIN_PATH}?redirect=${encodeURIComponent(fullPath())}`);
  }
});
