// Client-side auth guard + minimal hash router for the framework-free web app — TM-109 / 2.2.5.
//
// Views, mapped onto page panels:
//   #/login → the sign-in form  (#auth-signed-out) — public
//   #/home  → authenticated home (#auth-signed-in)  — protected; renders identity from
//             GET /api/v1/me (wired by me.js / TM-108)
//   #/admin       → admin hub (#admin-hub-view)      — protected + ADMIN-only (TM-133/TM-917)
//   #/admin/users → admin users console (#admin-view) — protected + ADMIN-only (TM-133; moved TM-917)
//
// The ADMIN gate reads the verified ID-token `role` claim (TM-110); the backend (TM-111) is the
// real authority — this just hides an unusable page from non-admins.
//
// The guard is UX only — the backend is default-deny (TM-79), which is the real gate. This
// just keeps signed-out users out of protected views and returns them after they sign in.
//
// Owns view visibility (login.js no longer toggles the panels) and the nav's login↔sign-out
// control. Reacts to both `hashchange` and Firebase auth-state changes.

import { onAuthChanged, currentUser, getRole } from "./auth.js";
import { enterAdmin } from "./admin.js";
// Admin hub (TM-917) — the #/admin second-level nav over the five consoles, opened by the bottom-bar
// Admin tab (TM-916). admin-hub.js mounts it into #admin-hub-view; the users console moved to
// #/admin/users. ADMIN-only, same server gate as every other admin route (TM-133).
import { enterAdminHub } from "./admin-hub.js";
import { enterAdminEvents, enterAdminEventForm } from "./admin-events.js";
import { isAdminEventFormRoute, parseAdminEventFormRoute } from "./admin-event-route.js";
// Admin venues console + create/edit form (TM-519) — ADMIN-only, same gate as #/admin/events. The
// list is #/admin/venues; the form is #/admin/venues/new (create) and #/admin/venues/{id}/edit (edit).
// admin-venues.js mounts the list into #admin-venues-view and the form into #admin-venue-form-view;
// the route math (the dynamic-id edit route) is the pure admin-venues-route.js (unit-tested).
import { enterAdminVenues, enterAdminVenueForm } from "./admin-venues.js";
import { isAdminVenueFormRoute, parseAdminVenueFormRoute } from "./admin-venues-route.js";
// Admin interests console + create/edit form (TM-779) — ADMIN-only, same gate as #/admin/venues. The
// list is #/admin/interests (with the inline min/max config panel); the form is #/admin/interests/new
// (create) and #/admin/interests/{id}/edit (edit). admin-interests.js mounts the list into
// #admin-interests-view and the form into #admin-interest-form-view; the route math (the dynamic-id edit
// route) is the pure admin-interests-route.js (unit-tested).
import { enterAdminInterests, enterAdminInterestForm } from "./admin-interests.js"; // TM-779
import { isAdminInterestFormRoute, parseAdminInterestFormRoute } from "./admin-interests-route.js"; // TM-779
// Admin message compose (TM-443): the full-page #/admin/messages/new compose form, ADMIN-only (same
// gate as #/admin). admin-messages.js mounts it into #admin-message-form-view; the route math is the
// pure admin-message-route.js (unit-tested on the PR gate). Kept additive to this shared router.
import { enterAdminMessageCompose } from "./admin-messages.js";
// Admin sent-history list (TM-444): the full-page #/admin/messages sent-message list, ADMIN-only (same
// gate as #/admin). admin-sent-history.js mounts it into #admin-message-list-view; the route math (the
// exact-match #/admin/messages predicate) is the pure admin-message-route.js. Additive to this router.
import { enterAdminSentHistory } from "./admin-sent-history.js";
import { isAdminMessageComposeRoute, ADMIN_MESSAGES_ROUTE } from "./admin-message-route.js";
import { enterProfile } from "./profile.js";
import { enterEvents } from "./events.js";
import { enterHome } from "./home.js";
import { enterChat } from "./chat.js";
import { enterNotifications } from "./notifications.js";
import { enterOnboarding } from "./onboarding.js";
import { enterTerms } from "./terms.js";
import { needsTermsAcceptance } from "./terms-gate.js";
// TM-880: phone is mandatory. The pure rule (no valid stored E.164 phone → route through the
// first-use completion gate) lives in profile-core so it's unit-testable; it applies to ALL users,
// existing phone-less accounts included, and fails open on a degraded /me like the other gates.
// TM-932 adds needsVerifiedPhone: a stored phone that is NOT the account's Firebase-verified number
// re-gates too (the retroactive half of TM-923's strict "one verified number = one account"). Both
// pure rules live in profile-core so they're unit-testable; both fail OPEN on a degraded /me.
import { needsPhoneNumber, needsVerifiedPhone } from "./profile-core.js";
// TM-992 (decision C = GRACE, then FORCE): the retroactive verified-phone re-gate is no longer an
// immediate hard bounce. phoneReverifyDecision decides — from needsVerifiedPhone's outcome, a
// CONFIG-DRIVEN deadline, and now — whether this entry is a soft nudge (grace) or a hard gate. The
// verified-phone term only folds into isOnboarded once the decision is HARD_GATE (grace is over); a
// GRACE_NUDGE leaves the user un-gated (the dismissible notice — phone-reverify-notice.js — handles the
// nudge). SAFE DEFAULT: with no deadline configured the decision is grace-only, so we never lock an
// existing user out before product sets a date.
import {
  phoneReverifyDecision,
  parseReverifyDeadline,
  ReverifyDecision,
} from "./phone-reverify-core.js";
import { shouldBounceNonAdmin } from "./admin-route-guard-core.js";
import { enterHelp } from "./help.js";
import { enterDiagnostics } from "./diagnostics.js";
// Membership tier screen (TM-480 built the screen; TM-606 wires it live through this router). The screen
// + its pure logic live in membership-tier.js; router.js now owns its show/hide + mount lifecycle (the
// screen's old self-managed hashchange listener was removed in TM-606). `membershipEnabled()` reads the
// single `config.flags.membership` flag (shipped OFF) so the WHOLE route is gated in one place — with the
// flag off, `#/membership` isn't a known route here and falls through to the auth default, staying inert.
import { enterMembershipTier, membershipEnabled } from "./membership-tier.js";
// Subscribe checkout (TM-620): the paid flow behind the tier screen's Subscribe actions, at
// #/membership/subscribe/{TIER}. Same flag-gating rule as the tier screen — with the flag off the
// route isn't known here and the screen stays inert.
import { enterMembershipSubscribe } from "./membership-subscribe.js";
// My tickets / purchases + receipts screen (TM-481 built it; TM-624 wires it live through this router).
// Like the tier screen (TM-606), router.js now owns its show/hide + auth guard + mount lifecycle + nav
// reveal; the screen's old self-managed hashchange listener + nav reveal were removed in TM-624. Gated by
// the SAME `membershipEnabled()` (config.flags.membership, shipped OFF) so the whole route is inert until
// the flag flips — with the flag off `#/receipts` is not a known route here and falls through to the auth
// default. `membershipEnabled` is imported once from membership-tier.js (the single flag source).
import { enterMembershipReceipts } from "./membership-receipts.js";
import { getMe } from "./api.js";
import { toast } from "./ui.js";
import { settleOrFallback } from "./async-util.js";
import { updateTabbar } from "./tabbar.js";
import { updateFooter } from "./footer.js";
// App-shell brand block (TM-885/TM-886): the walking-skeleton wordmark + tagline + #status line at
// the top of <main class="app">. Router-driven like the tab bar / footer so it hides on the screens
// that own their full-page header (Profile + the first-run gates) — the pure rule lives in
// shell-brand-core.js (unit-tested); this is its DOM bridge.
import { updateShellBrand } from "./shell-brand.js";
// Corner-bell chrome (TM-910): on the self-headed surfaces (Profile now; Home/Events add their route
// in their own lanes) remove the floating hamburger + nav-items row and pin the notification bell to
// the top-right corner, so the screen's own heading is the first content. Router-driven like the
// shell-brand block above; the pure route rule lives in corner-bell-core.js (unit-tested), this is
// its DOM bridge.
import { updateCornerBell } from "./corner-bell.js";
import { updateChatTabBadge } from "./chat-tab-badge.js";
import { updateNotificationBell } from "./notification-bell.js";

const LOGIN = "#/login";
const HOME = "#/home";
const ADMIN = "#/admin";
// Admin users console route (TM-917) — moved off #/admin (now the hub) to its own hash. Same
// ADMIN-only gate as #/admin; admin.js mounts it into #admin-view (unchanged container).
const ADMIN_USERS = "#/admin/users";
// Admin events console (TM-395) — protected + ADMIN-only, the same gate as #/admin. Its own hash so
// it's a distinct exact-match route; admin-events.js mounts into #admin-events-view.
const ADMIN_EVENTS = "#/admin/events";
// Admin venues console (TM-519) — protected + ADMIN-only, the same gate as #/admin/events. Its own
// exact-match hash; admin-venues.js mounts into #admin-venues-view.
const ADMIN_VENUES = "#/admin/venues";
// Admin interests console (TM-779) — protected + ADMIN-only, the same gate as #/admin/venues. Its own
// exact-match hash; admin-interests.js mounts into #admin-interests-view.
const ADMIN_INTERESTS = "#/admin/interests"; // TM-779
// Admin sent-history list (TM-444) — protected + ADMIN-only, the same gate as #/admin. Its own exact
// hash (the bare #/admin/messages, distinct from the #/admin/messages/new compose sub-route, TM-443);
// admin-sent-history.js mounts into #admin-message-list-view. The one route string lives in
// admin-message-route.js (ADMIN_MESSAGES_ROUTE), imported here so it isn't duplicated.
const ADMIN_MESSAGES = ADMIN_MESSAGES_ROUTE;
// Full-page create/edit event form (TM-426) — ADMIN-only, same gate as #/admin/events. The form used
// to be a modal that overflowed short viewports (TM-421); it's now its own page at #/admin/events/new
// (create) and #/admin/events/{id}/edit (edit). The edit route carries a dynamic id, so — like the
// events detail — these are matched by pattern (admin-event-route.js) rather than the exact-match set,
// and admin-events.js mounts them into #admin-event-form-view.
// Self-service Profile view (TM-167; refreshed to the paper wireframes in TM-514) — protected,
// available to any signed-in user. `#/profile` is the Profile hub + inline edit form; `#/profile/public`
// (TM-514) is the additive "how others see you" public-profile preview. Both mount into #profile-view
// and both light the bottom-nav Profile tab (tabbar-core treats any `#/profile/...` as the Profile tab).
const PROFILE = "#/profile";
const PROFILE_PUBLIC = "#/profile/public";
// First-login profile gate (TM-250) — protected; a signed-in but not-yet-onboarded user is forced
// here and can't reach any other app view until they complete it.
const ONBOARDING = "#/onboarding";
// Terms/privacy acceptance gate (TM-170) — protected; a signed-in, onboarded user who hasn't
// accepted the current terms version (new user, or anyone after a version bump) is forced here and
// can't reach any other app view until they accept. Sits AFTER the onboarding gate in the chain.
const TERMS = "#/terms";
// Static Help guide (TM-255) — PUBLIC: reachable signed-in or signed-out, so it's deliberately NOT
// in PROTECTED. The onboarding gate (below) still wins over it for a signed-in, not-yet-onboarded
// user, so the gate can't be side-stepped via #/help.
const HELP = "#/help";
// QA diagnostics view (TM-297) — GPS / FCM-token / native-plugin readouts. PROTECTED (signed-in only):
// it's a QA enabler reached from the profile/settings area, not a public page, and the push/token
// readout only makes sense for a signed-in session. It is NOT promoted in the main nav (unobtrusive).
const DIAGNOSTICS = "#/diagnostics";
// User events UI (TM-396) — protected, available to any signed-in user. The list is `#/events`; a
// detail is `#/events/{id}` (also the push deep-link target). Because the detail carries a dynamic id
// it can't live in the exact-match PROTECTED set, so events routes are matched by prefix instead
// (see isEventsRoute / isProtected below).
const EVENTS = "#/events";
// Chat (TM-515 / TM-433) — protected, available to any signed-in, onboarded user. The chat LIST is
// `#/chat`; a THREAD is `#/chat/{id}` (chat.js renders both into #chat-view). Because the thread
// carries a dynamic id it can't live in the exact-match PROTECTED set, so — like the events area —
// chat routes are matched by prefix (isChatRoute / chatThreadId below). Refreshed from the TM-434
// "coming soon" placeholder to the real wireframes here in TM-515.
const CHAT = "#/chat";
// Notifications feed (TM-515) — protected, any signed-in, onboarded user. The grouped
// paper-notifications screen; notifications.js mounts into #notifications-view. Reached from the top
// nav "Notifications" link (the bottom nav's four tabs have no room; the wireframe shows it as a
// pushed screen with a back-to-home button).
const NOTIFICATIONS = "#/notifications";
// Membership tier management (TM-480 screen, wired live TM-606) — protected, available to any signed-in,
// onboarded user (per-user self-serve tier switch; NOT admin-only). membership-tier.js paints it into
// #membership-tier-screen and exposes enterMembershipTier(); the WHOLE route is gated behind the
// membership feature flag (config.flags.membership, shipped OFF) via isMembershipRoute() below — while
// the flag is off `#/membership` is not a known route, so it falls through to the auth default and the
// screen stays inert. Kept OUT of the static PROTECTED set (which is flag-independent) and handled by the
// flag-aware isMembershipRoute() instead, so a flag-off build never even treats it as a membership route.
const MEMBERSHIP = "#/membership";
// My tickets / purchases + receipts (TM-481 screen, wired live TM-624) — protected, any signed-in,
// onboarded user (per-user order history; NOT admin-only). membership-receipts.js paints it into
// #membership-receipts-screen and exposes enterMembershipReceipts(); the WHOLE route is gated behind the
// membership feature flag via isReceiptsRoute() below — while the flag is off `#/receipts` is not a known
// route, so it falls through to the auth default and the screen stays inert. Kept OUT of the static
// PROTECTED set (flag-independent) and handled by the flag-aware isReceiptsRoute() instead, exactly like
// the membership tier route.
const RECEIPTS = "#/receipts";
const PROTECTED = new Set([HOME, ADMIN, ADMIN_USERS, ADMIN_EVENTS, ADMIN_VENUES, ADMIN_INTERESTS, ADMIN_MESSAGES, PROFILE, CHAT, NOTIFICATIONS, ONBOARDING, TERMS, DIAGNOSTICS]); // TM-779: + ADMIN_INTERESTS; TM-917: + ADMIN_USERS (the moved users console must stay auth-gated like the old #/admin — a signed-out deep-link is remembered + bounced to login, not flashed then home-bounced)

/** True for the events list (`#/events`) or any event detail (`#/events/{id}`). */
function isEventsRoute(hash) {
  return hash === EVENTS || hash.startsWith(`${EVENTS}/`);
}
/**
 * TM-721: decodeURIComponent THROWS a URIError on a malformed percent-escape (e.g. a hand-typed or
 * corrupted deep link like `#/events/%E0%A4%A` or a lone `%`). eventDetailId/chatThreadId run inside
 * currentRoute() → guard(), so an un-caught throw there crashed the whole router on navigation. Decode
 * defensively: fall back to the RAW segment on a bad escape (the screen then just shows a "couldn't load"
 * state for that id rather than the router dying).
 */
function safeDecodeSegment(rest) {
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** The detail id from `#/events/{id}`, or null for the list route / a non-events hash. */
function eventDetailId(hash) {
  if (!hash.startsWith(`${EVENTS}/`)) return null;
  const rest = hash.slice(EVENTS.length + 1);
  return rest ? safeDecodeSegment(rest) : null;
}
/** True for the Profile hub (`#/profile`) or the public-profile preview (`#/profile/public`, TM-514). */
function isProfileRoute(hash) {
  return hash === PROFILE || hash === PROFILE_PUBLIC;
}
/** True for the chat list (`#/chat`) or any chat thread (`#/chat/{id}`). */
function isChatRoute(hash) {
  return hash === CHAT || hash.startsWith(`${CHAT}/`);
}
/** The thread id from `#/chat/{id}`, or null for the list route / a non-chat hash. */
function chatThreadId(hash) {
  if (!hash.startsWith(`${CHAT}/`)) return null;
  const rest = hash.slice(CHAT.length + 1);
  return rest ? safeDecodeSegment(rest) : null; // TM-721: don't throw on a malformed %-escape (see above)
}
/** True for the membership tier screen route (TM-606) — but ONLY a known route while the membership
 *  feature flag is ON. With the flag OFF this is always false, so `#/membership` is treated as an unknown
 *  hash (falls through to the auth default) and the whole screen stays inert until the flag flips. */
function isMembershipRoute(hash) {
  return membershipEnabled() && hash === MEMBERSHIP;
}
/** True for the Subscribe checkout route (TM-620): `#/membership/subscribe[/{TIER}]` — the same
 *  flag-gating rule as the tier screen, so a flag-off build treats it as an unknown hash and the whole
 *  checkout stays inert until the membership flag flips. Tier validity is the screen's own job
 *  (membership-subscribe-core.js parses the same prefix). */
function isMembershipSubscribeRoute(hash) {
  return membershipEnabled() && (hash === `${MEMBERSHIP}/subscribe` || hash.startsWith(`${MEMBERSHIP}/subscribe/`));
}
/** True for the receipts screen route (TM-624) — but ONLY a known route while the membership feature flag
 *  is ON. With the flag OFF this is always false, so `#/receipts` is treated as an unknown hash (falls
 *  through to the auth default) and the whole screen stays inert until the flag flips. Mirrors
 *  isMembershipRoute exactly — one flag, gated in this one place. */
function isReceiptsRoute(hash) {
  return membershipEnabled() && hash === RECEIPTS;
}
/** A route requires sign-in when it's in the exact protected set, a profile route, the events or chat
 *  area, or the admin event form (ADMIN-only, so protected too) — union of TM-514 + TM-515. */
function isProtected(route) {
  return (
    PROTECTED.has(route) ||
    isProfileRoute(route) ||
    isEventsRoute(route) ||
    isChatRoute(route) ||
    isAdminEventFormRoute(route) ||
    // Admin venue create/edit form (TM-519) — ADMIN-only, so protected too.
    isAdminVenueFormRoute(route) ||
    // Admin interest create/edit form (TM-779) — ADMIN-only, so protected too.
    isAdminInterestFormRoute(route) ||
    // Admin message compose (TM-443) — ADMIN-only, so protected too.
    isAdminMessageComposeRoute(route) ||
    // Membership tier screen (TM-606) — protected (any signed-in user) when the flag is on.
    isMembershipRoute(route) ||
    // Subscribe checkout (TM-620) — protected (any signed-in user) when the flag is on.
    isMembershipSubscribeRoute(route) ||
    // Receipts / my-tickets screen (TM-624) — protected (any signed-in user) when the flag is on. This
    // gives it the auth guard the TM-481 self-managed version lacked (a signed-out deep link now bounces
    // to login + returns after sign-in, instead of firing GET /me/orders with no token).
    isReceiptsRoute(route)
  );
}

// Cached from the verified ID-token `role` claim (TM-110), refreshed on every auth change so the
// guard + nav can decide synchronously. Fails safe to false (non-admin) until resolved.
let isAdmin = false;
// Whether the role lookup has actually resolved for the current auth state (TM-733). Starts false so a
// deep-link / reload straight to an admin route is HELD rather than bounced with a spurious "Admins
// only." toast while `isAdmin` is still its fail-safe default; set true once resolveRoleThenGuard
// settles the role (or on sign-out, where the non-admin verdict is definitive). The admin bounce
// (shouldBounceNonAdmin) fires ONLY once the role is resolved and confirmed non-admin.
let roleResolved = false;
// Whether the signed-in caller has completed first-login onboarding (TM-250). Resolved from
// GET /api/v1/me alongside the role on each auth change, so the gate decision is synchronous in the
// guard. Fails OPEN (true = not gated) on a lookup error: a backend hiccup must never trap a user
// behind the gate with no way through — the backend is still the real authority on what they can do.
let isOnboarded = true;
// TM-992: the retroactive phone re-verify DEADLINE (decision C = GRACE, then FORCE), a PROD-CONFIG value
// (`window.TEAMMARHABA_CONFIG.phoneReverifyDeadline`, injected at deploy time like apiBaseUrl). Read
// through this helper so it's a single seam and safe off-DOM. Absent/null (the committed default) means
// GRACE-ONLY: phoneReverifyDecision never hard-gates without a real deadline, so we can't lock existing
// users out before product picks a date. Product flips this to an ISO-8601 date to start the countdown.
function reverifyDeadlineConfig() {
  return (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG?.phoneReverifyDeadline) || null;
}
// Whether the signed-in caller still needs to accept the current terms version (TM-170). Resolved
// from GET /api/v1/me alongside onboarding on each auth change (the pure rule in terms-gate.js),
// so the gate decision is synchronous in the guard. Fails CLOSED here? No — fails OPEN (false = not
// gated): a /me hiccup leaves currentTermsVersion absent and needsTermsAcceptance() returns false,
// so a backend hiccup never traps a user behind the terms gate. The backend stays the real authority.
let needsTerms = false;
// Whether the admin console is currently mounted/loaded, so we (re)load it only on entry.
let adminActive = false;
// Hub (#/admin) entry flag — separate from the users console (#/admin/users) so each mounts/reloads
// on its own entry (TM-917).
let adminHubActive = false;
// Same lifecycle for the admin events console (TM-395): mount once, (re)load on entry.
let adminEventsActive = false;
// Admin event form (TM-426): the last form route we entered (#/admin/events/new or …/{id}/edit), so a
// repeated guard() for the SAME route doesn't re-render, while switching create↔edit↔another-edit does.
// Reset to null when leaving the form (mirrors eventsRouteEntered).
let adminEventFormEntered = null;
// Admin venues console (TM-519): whether the venues list is currently mounted, so we (re)load it only
// on entry (mirrors adminEventsActive).
let adminVenuesActive = false;
// Admin venue form (TM-519): the last form route we entered (#/admin/venues/new or …/{id}/edit), so a
// repeated guard() for the SAME route doesn't re-render, while switching create↔edit↔another-edit does
// (mirrors adminEventFormEntered).
let adminVenueFormEntered = null;
// Admin interests console (TM-779): whether the interests list is currently mounted, so we (re)load it
// only on entry (mirrors adminVenuesActive).
let adminInterestsActive = false; // TM-779
// Admin interest form (TM-779): the last form route we entered (#/admin/interests/new or …/{id}/edit), so
// a repeated guard() for the SAME route doesn't re-render, while switching create↔edit↔another-edit does
// (mirrors adminVenueFormEntered).
let adminInterestFormEntered = null; // TM-779
// Admin message compose (TM-443): whether the compose page is currently mounted, so we mount it once on
// entry and reset on leaving (mirrors the single-route views like notifications). The route is a single
// exact hash (#/admin/messages/new), so a boolean is enough — there's no id to switch between.
let adminMessageComposeEntered = false;
// Admin sent-history list (TM-444): whether the list view is currently mounted, so we mount it once on
// entry into #/admin/messages and reset on leaving (mirrors the single-route views like the events
// console). Re-entry reloads from page 0 so a just-sent campaign shows at the top.
let adminMessagesActive = false;
// Profile view (TM-167; TM-514): the last profile sub-route we entered (`#/profile` hub or
// `#/profile/public` preview), so a repeated guard() for the SAME route doesn't rebuild/refetch, while
// switching hub↔preview re-enters. Reset to null when leaving the profile area. (This route-entered
// lifecycle from TM-514 replaces the old single `profileActive` flag.)
let profileRouteEntered = null;
// Chat (TM-515): the last chat route we entered (`#/chat` or `#/chat/{id}`), so repeated guard() calls
// for the SAME route don't re-render, while a list↔thread↔another-thread change re-enters (mirrors
// eventsRouteEntered). Reset to null when leaving the chat area. Replaces the TM-434 `chatActive`
// "coming soon" stub, which the real TM-515 chat view no longer needs.
let chatRouteEntered = null;
// Same lifecycle as the edit-profile view for the notifications feed (TM-515): mount + rebuild on
// entry, reset on leaving so a future entry re-enters with a fresh feed.
let notificationsActive = false;
// Membership tier screen (TM-606): whether it's currently mounted, so we mount + fetch the caller's
// membership once on entry into #/membership and reset on leaving so a future entry re-fetches (a fresh
// tier after a switch made elsewhere). Only ever entered while the flag is on. Same single-route,
// mount-once lifecycle as the notifications feed above.
let membershipActive = false;
// Subscribe checkout (TM-620): the currently mounted subscribe ROUTE (null when off it). Tracked as
// the route string rather than a boolean so moving between the two tier variants
// (#/membership/subscribe/MONTHLY ↔ /DIAMOND) re-mounts with the right tier.
let membershipSubscribeActive = null;
// Receipts / my-tickets screen (TM-624): whether it's currently mounted, so we mount + fetch the caller's
// orders once on entry into #/receipts and reset on leaving so a future entry re-fetches (fresh orders
// after a checkout elsewhere). Only ever entered while the flag is on. Same single-route, mount-once
// lifecycle as the membership tier screen.
let receiptsActive = false;
// Home feed (TM-512): mount the "Events near you" feed / empty-home into #auth-signed-in on entry,
// reset on leaving so returning to Home re-fetches (fresh counts / RSVP state after acting elsewhere).
let homeActive = false;
// Same lifecycle for the onboarding gate view (TM-250): mount once, (re)load on entry.
let onboardingActive = false;
// Same lifecycle for the terms gate view (TM-170): mount once, (re)load on entry.
let termsActive = false;
// Same idea for the static Help view (TM-255): mount once on entry, reset on leaving.
let helpActive = false;
// Same lifecycle for the QA diagnostics view (TM-297): mount once on entry, refresh its live readouts
// each entry (handled inside enterDiagnostics), reset on leaving so a future entry re-enters.
let diagnosticsActive = false;
// Events UI (TM-396): the last events route we entered (`#/events` or `#/events/{id}`), so repeated
// guard() calls for the SAME route (e.g. the 2–3 fired on load / auth-resolve) don't refetch, while a
// list↔detail↔another-detail change still re-enters. Reset to null when leaving the events area.
let eventsRouteEntered = null;
// Where to send a signed-out user who tried to reach a protected view, so we can return them
// after sign-in. Shared with api.js's 401 redirect (same key).
const INTENDED_KEY = "tm.intendedRoute";

// TM-721: sessionStorage can THROW on mere access — a locked-down WebView, a private/incognito context,
// or a browser with cookies/site-data blocked raises SecurityError on getItem/setItem, not just on the
// property lookup. The guard() below leaned on it directly, so in those contexts a routine navigation
// (e.g. a signed-out deep-link to a protected route) crashed the whole router. These wrappers make the
// intended-route memory best-effort: it degrades to "forget where they were headed" (they land on the
// role default after login) instead of throwing. Mirrors api.js's own defensive storage access.
function safeSessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable (blocked/locked-down) — best-effort, so just skip remembering. */
  }
}
function safeSessionRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable — nothing to clear. */
  }
}

const $ = (id) => document.getElementById(id);

/** Normalise the current location hash to one of our known routes. */
function currentRoute() {
  const hash = window.location.hash;
  if (hash === LOGIN || hash === HOME || hash === ADMIN || hash === ADMIN_USERS || hash === ADMIN_EVENTS || hash === ADMIN_VENUES || hash === ADMIN_INTERESTS || hash === ADMIN_MESSAGES || hash === PROFILE || hash === PROFILE_PUBLIC || hash === CHAT || hash === NOTIFICATIONS || hash === ONBOARDING || hash === TERMS || hash === HELP || hash === DIAGNOSTICS) return hash; // TM-779: + ADMIN_INTERESTS; TM-917: + ADMIN_USERS
  // Events area (list or a dynamic-id detail): return the raw hash so the detail id survives.
  if (isEventsRoute(hash)) return hash;
  // Chat area (list or a dynamic-id thread): return the raw hash so the thread id survives (TM-515).
  if (isChatRoute(hash)) return hash;
  // Admin event form (create/edit): return the raw hash so the {id} in an edit route survives (TM-426).
  if (isAdminEventFormRoute(hash)) return hash;
  // Admin venue form (create/edit): return the raw hash so the {id} in an edit route survives (TM-519).
  if (isAdminVenueFormRoute(hash)) return hash;
  // Admin interest form (create/edit): return the raw hash so the {id} in an edit route survives (TM-779).
  if (isAdminInterestFormRoute(hash)) return hash; // TM-779
  // Admin message compose (TM-443): the exact #/admin/messages/new route.
  if (isAdminMessageComposeRoute(hash)) return hash;
  // Membership tier screen (TM-606): the exact #/membership route, but ONLY when the membership flag is
  // ON — with the flag off this predicate is false, so #/membership falls through to the auth default
  // below and the screen stays inert.
  if (isMembershipRoute(hash)) return hash;
  // Subscribe checkout (TM-620): #/membership/subscribe/{TIER}, same flag rule — the raw hash is
  // returned so the tier segment survives for the screen to parse.
  if (isMembershipSubscribeRoute(hash)) return hash;
  // Receipts / my-tickets (TM-624): the exact #/receipts route, but ONLY when the membership flag is ON
  // — with the flag off this predicate is false, so #/receipts falls through to the auth default below
  // and the screen stays inert (mirrors the membership tier route).
  if (isReceiptsRoute(hash)) return hash;
  // Unknown/empty hash: default by auth state.
  return currentUser() ? HOME : LOGIN;
}

/** Navigate by setting the hash (triggers the hashchange handler). */
function go(route) {
  if (window.location.hash !== route) {
    window.location.hash = route;
  } else {
    render(); // already on this hash — re-render (e.g. after auth change)
  }
}

/** Show the view for `route`, hide the other, and reflect auth state in the nav. */
function render() {
  const signedIn = Boolean(currentUser());
  const route = currentRoute();

  const loginView = $("auth-signed-out");
  const homeView = $("auth-signed-in");
  const adminHubView = $("admin-hub-view");
  const adminView = $("admin-view");
  const adminEventsView = $("admin-events-view");
  const adminEventFormView = $("admin-event-form-view");
  const adminVenuesView = $("admin-venues-view");
  const adminVenueFormView = $("admin-venue-form-view");
  const adminInterestsView = $("admin-interests-view"); // TM-779
  const adminInterestFormView = $("admin-interest-form-view"); // TM-779
  const profileView = $("profile-view");
  const onboardingView = $("onboarding-view");
  const termsView = $("terms-view");
  const helpView = $("help-view");
  const diagnosticsView = $("diagnostics-view");
  const eventsView = $("events-view");
  const chatView = $("chat-view");
  const notificationsView = $("notifications-view");
  if (loginView) loginView.hidden = route !== LOGIN;
  if (homeView) homeView.hidden = route !== HOME;
  if (adminHubView) adminHubView.hidden = route !== ADMIN;
  if (adminView) adminView.hidden = route !== ADMIN_USERS;
  if (adminEventsView) adminEventsView.hidden = route !== ADMIN_EVENTS;
  // Admin event form (TM-426) — shown for the create route and any {id} edit route.
  if (adminEventFormView) adminEventFormView.hidden = !isAdminEventFormRoute(route);
  // Admin venues console (TM-519) — shown for the exact #/admin/venues route.
  if (adminVenuesView) adminVenuesView.hidden = route !== ADMIN_VENUES;
  // Admin venue form (TM-519) — shown for the create route and any {id} edit route.
  if (adminVenueFormView) adminVenueFormView.hidden = !isAdminVenueFormRoute(route);
  // Admin interests console (TM-779) — shown for the exact #/admin/interests route.
  if (adminInterestsView) adminInterestsView.hidden = route !== ADMIN_INTERESTS; // TM-779
  // Admin interest form (TM-779) — shown for the create route and any {id} edit route.
  if (adminInterestFormView) adminInterestFormView.hidden = !isAdminInterestFormRoute(route); // TM-779
  // Admin message compose (TM-443) — shown for the exact #/admin/messages/new route.
  const adminMessageFormView = $("admin-message-form-view");
  if (adminMessageFormView) adminMessageFormView.hidden = !isAdminMessageComposeRoute(route);
  // Admin sent-history list (TM-444) — shown for the exact #/admin/messages route.
  const adminMessageListView = $("admin-message-list-view");
  if (adminMessageListView) adminMessageListView.hidden = route !== ADMIN_MESSAGES;
  if (profileView) profileView.hidden = !isProfileRoute(route);
  if (onboardingView) onboardingView.hidden = route !== ONBOARDING;
  if (termsView) termsView.hidden = route !== TERMS;
  if (helpView) helpView.hidden = route !== HELP;
  if (diagnosticsView) diagnosticsView.hidden = route !== DIAGNOSTICS;
  // Events UI (TM-396) — shown for the list and any event detail.
  if (eventsView) eventsView.hidden = !isEventsRoute(route);
  // Chat (TM-515) — shown for the list and any thread (#/chat or #/chat/{id}).
  if (chatView) chatView.hidden = !isChatRoute(route);
  // Notifications feed (TM-515) — shown for the exact #/notifications route.
  if (notificationsView) notificationsView.hidden = route !== NOTIFICATIONS;
  // Membership tier screen (TM-606) — shown for the exact #/membership route. `route` is only ever
  // MEMBERSHIP while the flag is on (isMembershipRoute gates currentRoute()), so with the flag off this
  // stays hidden and the screen is inert.
  const membershipView = $("membership-tier-screen");
  if (membershipView) membershipView.hidden = route !== MEMBERSHIP;
  // Subscribe checkout (TM-620) — shown for the #/membership/subscribe/{TIER} routes (flag-gated the
  // same way; with the flag off the predicate is false and the section stays hidden).
  const membershipSubscribeView = $("membership-subscribe-screen");
  if (membershipSubscribeView) membershipSubscribeView.hidden = !isMembershipSubscribeRoute(route);
  // Membership checkout (TM-479) is a per-event CONTEXTUAL overlay opened via
  // window.tmMembershipCheckout.open(event) — it has no hash route of its own. Router hygiene: hide it on
  // every (re)render so a stale checkout is dismissed whenever we navigate. open() runs on a user click
  // and never triggers render(), so this never fights it. Inert while the flag is OFF — nothing opens it.
  const checkoutView = $("membership-checkout-screen");
  if (checkoutView) checkoutView.hidden = true;
  // Receipts / my-tickets screen (TM-624) — shown for the exact #/receipts route. `route` is only ever
  // RECEIPTS while the flag is on (isReceiptsRoute gates currentRoute()), so with the flag off this stays
  // hidden and the screen is inert (mirrors the membership tier screen above).
  const receiptsView = $("membership-receipts-screen");
  if (receiptsView) receiptsView.hidden = route !== RECEIPTS;

  // While EITHER first-run gate is up — not-yet-onboarded (TM-250) or terms not accepted (TM-170) —
  // suppress the in-app nav links so the user can't side-step the gate; only the public Help link
  // stays (so they can read the terms). NB (TM-906): sign-out moved to the Profile hub, which a
  // GATED user cannot reach — so while gated there is currently no sign-out affordance at all
  // (deliberate per TM-906's "profile is the only entry"; revisit if the gates need an escape).
  const gated = signedIn && (!isOnboarded || needsTerms);

  // Canonical auth-state signal (TM-906): a `data-auth` attribute on <body>, flipped on every render
  // (render() runs on each hashchange + auth change). This replaced the old top-nav sign-out control
  // as THE stable "signed in" signal the e2e suite waits on — unlike any nav element it is immune to
  // viewport collapse (the hamburger), the first-run gates (which hide most nav), and future nav
  // reshuffles. Values: "signed-in" | "signed-out"; absent only before the first render.
  document.body.dataset.auth = signedIn ? "signed-in" : "signed-out";

  // Nav reflects auth state: a sign-in link when signed out. (The top-nav sign-out control was
  // REMOVED in TM-906 — sign-out now lives ONLY on the Profile hub's menu row, behind a confirm.)
  const navSignIn = $("nav-signin");
  const navAdmin = $("nav-admin");
  const navProfile = $("nav-profile");
  if (navSignIn) navSignIn.hidden = signedIn;
  // The Help-page link (TM-255) is normally always shown (public, signed-in or out), but is hidden
  // while the first-login gate is up so a gated user can't side-step it via the nav (the guard also
  // bounces them back to the gate, but hiding the link keeps the gated nav clean).
  const navHelpLink = $("nav-help-link");
  if (navHelpLink) navHelpLink.hidden = gated;
  // The Events link (TM-396) shows for any signed-in, onboarded user (hidden while gated).
  const navEvents = $("nav-events");
  if (navEvents) navEvents.hidden = !signedIn || gated;
  // The Notifications link (TM-515) follows the same rule — any signed-in, onboarded user.
  const navNotifications = $("nav-notifications");
  if (navNotifications) navNotifications.hidden = !signedIn || gated;
  // The Membership link (TM-480 screen, wired live TM-606) — shown for any signed-in, onboarded user, but
  // ONLY while the membership feature flag is on (config.flags.membership, shipped OFF). Hidden signed-out,
  // while gated, and whenever the flag is off, so it stays inert until the flag flips (TM-478).
  const navMembership = $("nav-membership");
  if (navMembership) navMembership.hidden = !(signedIn && membershipEnabled()) || gated;
  // The My-tickets / receipts link (TM-481 screen, wired live TM-624) — same rule as the Membership link:
  // shown for a signed-in, onboarded user ONLY while the membership flag is on, hidden signed-out / while
  // gated / whenever the flag is off. This replaces the reveal membership-receipts.js used to do on its
  // own at boot (which ignored the signed-out + gated states), so it now respects them like every other link.
  const navReceipts = $("nav-receipts");
  if (navReceipts) navReceipts.hidden = !(signedIn && membershipEnabled()) || gated;
  // The edit-profile link shows for any signed-in, onboarded user (TM-167; hidden while gated).
  if (navProfile) navProfile.hidden = !signedIn || gated;
  // The admin link shows only for a signed-in, onboarded ADMIN (TM-133; hidden while gated). It
  // opens the #/admin hub (TM-917) — the single top-nav admin entry since TM-937 removed the
  // per-console links (events/venues/interests/messages); consoles are reached via the hub's rows.
  if (navAdmin) navAdmin.hidden = !(signedIn && isAdmin) || gated;
  const homeAdminLink = $("home-admin-link");
  if (homeAdminLink) homeAdminLink.hidden = !(signedIn && isAdmin) || gated;

  // Bottom tab bar (TM-434): reflect the same signed-in / gated / route state onto the primary mobile
  // nav — show it only for a signed-in, un-gated user (the CSS breakpoint restricts it to mobile), and
  // light the tab matching the current route. Driven from here so the tab bar shares router's single
  // source of truth (no second hashchange/auth listener). Hidden while EITHER first-run gate is up, so
  // a gated user can't side-step the gate via a tab. `isAdmin` (the verified TM-110 role claim, the
  // same flag the top-nav Admin link uses) adds the admin-only fifth tab (TM-915) — it fails safe to
  // false until resolveRoleThenGuard settles, so no admin tab flashes for a non-admin.
  updateTabbar({ signedIn, gated, route, isAdmin });

  // Chat-tab unread badge (TM-439): the unread pill over the bottom-nav Chat tab, gated to the SAME
  // signed-in, un-gated user as the bar. Driven from here so it shares router's single source of truth
  // — this gives the "refresh on route change" AC (render() runs on every hashchange + auth change).
  // NOTE (TM-585): this route-change refresh does NOT reliably drop the badge on the same open that
  // marks a thread read (its GET races the mark-read POST) — chat.js drives that drop explicitly instead.
  updateChatTabBadge({ signedIn, gated });

  // Notification bell (TM-455): the top-right header bell + unread badge, shown for the SAME
  // signed-in, un-gated user as the tab bar (hidden signed-out and on the onboarding / terms gates).
  // Driven from here so the bell shares router's single source of truth — this also gives the
  // "refresh on route change" AC for free, since render() runs on every hashchange + auth change.
  updateNotificationBell({ signedIn, gated });

  // Footer login/marketing fragments (TM-666): scope the Service-status link + phone-privacy note to
  // the logged-out login screen, and the "A product of 10xAI" byline to login / Home / Profile only —
  // so they're no longer painted on every in-app screen. Router-driven for the same single-source-of-
  // truth reason as the tab bar/bell above (render() reruns on every hashchange + auth change). Uses
  // the RAW signedIn/route (not the `gated` flag): the byline showing on Home/Profile is a cosmetic
  // credit, unrelated to the onboarding/terms gate, and a gated user only ever sees the gate route.
  updateFooter({ signedIn, route });

  // App-shell brand block (TM-885/TM-886): hide the walking-skeleton wordmark/tagline/#status on the
  // screens that render their OWN full-page header — the Profile hub/preview and the first-run gates
  // — so e.g. #/profile tops with "Profile", not a stray "Find your people — complete your circle" +
  // "Ready when you are." above it (the leak the tickets reported as the auth brand / boot splash not
  // being dismissed; the splash + auth card were in fact fine — this block was the leak). Router-
  // driven for the same single-source-of-truth reason as the tab bar / footer above.
  updateShellBrand({ route });

  // Corner-bell chrome (TM-910): on the self-headed surfaces (Profile) drop the floating hamburger +
  // nav-items row and pin the bell top-right, so the screen's own heading ("Profile") is the first
  // content. Same single-source-of-truth reason as updateShellBrand above (render() reruns on every
  // hashchange + auth change). The bell's own signed-in/gated visibility stays owned by
  // updateNotificationBell() — this only relocates the already-visible bell.
  updateCornerBell({ route });
}

/**
 * The guard: enforce the auth rules for the current (route, auth) pair, then render.
 *  - signed-out on a protected route → remember it and bounce to login.
 *  - signed-in on the login route    → return to the remembered route (or home).
 */
function guard() {
  const signedIn = Boolean(currentUser());
  const route = currentRoute();

  if (!signedIn && isProtected(route)) {
    safeSessionSet(INTENDED_KEY, route);
    go(LOGIN);
    return;
  }
  // First-login profile gate (TM-250). A signed-in user who hasn't completed onboarding is forced to
  // the gate and cannot reach ANY other view until they finish it. This precedes the login-return and
  // admin checks so the gate wins over them. The gate keeps the INTENDED route untouched, so once the
  // user completes it the normal login-return logic still lands them where they were headed.
  if (signedIn && !isOnboarded && route !== ONBOARDING) {
    // Preserve a deep-linked protected target (if not already remembered) so we can return there
    // after the gate; an in-app route like #/profile shouldn't be lost behind the gate.
    if (route !== LOGIN && !safeSessionGet(INTENDED_KEY)) {
      safeSessionSet(INTENDED_KEY, route);
    }
    go(ONBOARDING);
    return;
  }
  // Conversely, an already-onboarded user has no business on the gate — send them on.
  if (signedIn && isOnboarded && route === ONBOARDING) {
    const intended = safeSessionGet(INTENDED_KEY) || (isAdmin ? ADMIN : HOME);
    safeSessionRemove(INTENDED_KEY);
    go(intended);
    return;
  }
  // Terms/privacy acceptance gate (TM-170). After onboarding, a signed-in user who hasn't accepted
  // the current terms version is forced to #/terms and can't reach any other app view until they
  // accept. #/help is allowed through so they can actually READ the terms/privacy via the links in
  // the gate card (Help is the public legal/privacy surface, TM-242). Like the onboarding gate, the
  // INTENDED route is preserved so the user lands where they were headed once they accept.
  if (signedIn && isOnboarded && needsTerms && route !== TERMS && route !== HELP) {
    if (route !== LOGIN && !safeSessionGet(INTENDED_KEY)) {
      safeSessionSet(INTENDED_KEY, route);
    }
    go(TERMS);
    return;
  }
  // Conversely, a user who has accepted (or isn't gated) has no business on the terms gate — move on.
  if (signedIn && !needsTerms && route === TERMS) {
    const intended = safeSessionGet(INTENDED_KEY) || (isAdmin ? ADMIN : HOME);
    safeSessionRemove(INTENDED_KEY);
    go(intended);
    return;
  }
  if (signedIn && route === LOGIN) {
    // Land where the user was headed if they deep-linked a protected route before signing in;
    // otherwise by role — an ADMIN goes to the console, everyone else to home (TM-141).
    const intended = safeSessionGet(INTENDED_KEY) || (isAdmin ? ADMIN : HOME);
    safeSessionRemove(INTENDED_KEY);
    go(intended);
    return;
  }
  // Admin console is ADMIN-only (TM-133). A signed-in non-admin who reaches #/admin is sent home;
  // the backend (TM-111) is the real gate, this just avoids showing an unusable page.
  if (route === ADMIN && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminHubActive = false;
    go(HOME);
    return;
  }
  // Admin users console (TM-917) — moved off #/admin to #/admin/users; same ADMIN-only gate as the
  // hub above. The backend (TM-111) is the real authority; this just avoids an unusable page.
  if (route === ADMIN_USERS && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminActive = false;
    go(HOME);
    return;
  }
  // Admin events console is ADMIN-only too (TM-395), same rule as #/admin — the backend (TM-392) is
  // the real gate; this just avoids showing an unusable page to a non-admin.
  if (route === ADMIN_EVENTS && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminEventsActive = false;
    go(HOME);
    return;
  }
  // The full-page event create/edit form (TM-426) is ADMIN-only too — same rule as the events console.
  if (isAdminEventFormRoute(route) && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminEventFormEntered = null;
    go(HOME);
    return;
  }
  // Admin venues console (TM-519) is ADMIN-only too — same rule as #/admin/events; the backend is the
  // real gate, this just avoids showing an unusable page to a non-admin.
  if (route === ADMIN_VENUES && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminVenuesActive = false;
    go(HOME);
    return;
  }
  // The full-page venue create/edit form (TM-519) is ADMIN-only too — same rule as the venues console.
  if (isAdminVenueFormRoute(route) && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminVenueFormEntered = null;
    go(HOME);
    return;
  }
  // Admin interests console (TM-779) is ADMIN-only too — same rule as #/admin/venues; the backend
  // (TM-774) is the real gate, this just avoids showing an unusable page to a non-admin.
  if (route === ADMIN_INTERESTS && shouldBounceNonAdmin({ isAdmin, roleResolved })) { // TM-779
    toast("Admins only.", { type: "error" });
    adminInterestsActive = false;
    go(HOME);
    return;
  }
  // The full-page interest create/edit form (TM-779) is ADMIN-only too — same rule as the interests console.
  if (isAdminInterestFormRoute(route) && shouldBounceNonAdmin({ isAdmin, roleResolved })) { // TM-779
    toast("Admins only.", { type: "error" });
    adminInterestFormEntered = null;
    go(HOME);
    return;
  }
  // The full-page message compose form (TM-443) is ADMIN-only too — same rule as the consoles above.
  if (isAdminMessageComposeRoute(route) && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminMessageComposeEntered = false;
    go(HOME);
    return;
  }
  // The sent-history list (TM-444) is ADMIN-only too — same rule as #/admin; the backend (TM-442) is
  // the real gate, this just avoids showing an unusable page to a non-admin.
  if (route === ADMIN_MESSAGES && shouldBounceNonAdmin({ isAdmin, roleResolved })) {
    toast("Admins only.", { type: "error" });
    adminMessagesActive = false;
    go(HOME);
    return;
  }
  render();
  // Admin hub (TM-917): mount the #/admin second-level nav on entry, reset on leaving so re-entry
  // rebuilds if needed. The hub is static, so enterAdminHub() is itself idempotent.
  if (route === ADMIN && isAdmin) {
    if (!adminHubActive) {
      adminHubActive = true;
      enterAdminHub();
    }
  } else {
    adminHubActive = false;
  }
  // Admin users console (TM-917): the users console moved to #/admin/users — mount + (re)load its
  // list on entry, reset on leaving so a future entry reloads (unchanged lifecycle, new route).
  if (route === ADMIN_USERS && isAdmin) {
    if (!adminActive) {
      adminActive = true;
      enterAdmin();
    }
  } else {
    adminActive = false;
  }
  // Admin events console (TM-395): mount on entry, (re)load its list each entry, reset on leaving so
  // a future entry reloads. Same lifecycle as the users console above.
  if (route === ADMIN_EVENTS && isAdmin) {
    if (!adminEventsActive) {
      adminEventsActive = true;
      enterAdminEvents();
    }
  } else {
    adminEventsActive = false;
  }
  // Full-page event create/edit form (TM-426): (re)enter whenever the form route CHANGES (create vs a
  // specific edit id) so switching targets re-renders, without refetching on the repeated guard() calls
  // for the same route (mirrors the events list↔detail re-entry). Resolving the event for an edit lives
  // in admin-events.js. Reset on leaving — and returning to #/admin/events re-runs enterAdminEvents(),
  // which reloads the list so a just-saved create/edit shows immediately.
  if (isAdminEventFormRoute(route) && isAdmin) {
    if (route !== adminEventFormEntered) {
      adminEventFormEntered = route;
      const target = parseAdminEventFormRoute(route);
      enterAdminEventForm(target.mode, target.id);
    }
  } else {
    adminEventFormEntered = null;
  }
  // Admin venues console (TM-519): mount on entry, (re)load its list each entry, reset on leaving so a
  // future entry reloads. Same lifecycle as the events console above.
  if (route === ADMIN_VENUES && isAdmin) {
    if (!adminVenuesActive) {
      adminVenuesActive = true;
      enterAdminVenues();
    }
  } else {
    adminVenuesActive = false;
  }
  // Full-page venue create/edit form (TM-519): (re)enter whenever the form route CHANGES (create vs a
  // specific edit id), reset on leaving — and returning to #/admin/venues re-runs enterAdminVenues(),
  // which reloads the list so a just-saved create/edit shows immediately. Mirrors the event form.
  if (isAdminVenueFormRoute(route) && isAdmin) {
    if (route !== adminVenueFormEntered) {
      adminVenueFormEntered = route;
      const target = parseAdminVenueFormRoute(route);
      enterAdminVenueForm(target.mode, target.id);
    }
  } else {
    adminVenueFormEntered = null;
  }
  // Admin interests console (TM-779): mount on entry, (re)load its list each entry, reset on leaving so a
  // future entry reloads. Same lifecycle as the venues console above.
  if (route === ADMIN_INTERESTS && isAdmin) { // TM-779
    if (!adminInterestsActive) {
      adminInterestsActive = true;
      enterAdminInterests();
    }
  } else {
    adminInterestsActive = false;
  }
  // Full-page interest create/edit form (TM-779): (re)enter whenever the form route CHANGES (create vs a
  // specific edit id), reset on leaving — and returning to #/admin/interests re-runs enterAdminInterests(),
  // which reloads the list so a just-saved create/edit shows immediately. Mirrors the venue form.
  if (isAdminInterestFormRoute(route) && isAdmin) { // TM-779
    if (route !== adminInterestFormEntered) {
      adminInterestFormEntered = route;
      const target = parseAdminInterestFormRoute(route);
      enterAdminInterestForm(target.mode, target.id);
    }
  } else {
    adminInterestFormEntered = null;
  }
  // Full-page message compose (TM-443): mount once on entry into #/admin/messages/new, reset on leaving
  // so a future entry re-mounts a fresh draft. Single exact route, so a boolean guard is enough (unlike
  // the create/edit event form, which switches between id targets).
  if (isAdminMessageComposeRoute(route) && isAdmin) {
    if (!adminMessageComposeEntered) {
      adminMessageComposeEntered = true;
      enterAdminMessageCompose();
    }
  } else {
    adminMessageComposeEntered = false;
  }
  // Admin sent-history list (TM-444): mount once on entry into #/admin/messages, reset on leaving so a
  // future entry re-mounts and reloads from page 0 (a just-sent campaign then shows at the top). Single
  // exact route, so a boolean guard is enough (mirrors the compose lifecycle above).
  if (route === ADMIN_MESSAGES && isAdmin) {
    if (!adminMessagesActive) {
      adminMessagesActive = true;
      enterAdminSentHistory();
    }
  } else {
    adminMessagesActive = false;
  }
  // Profile view (TM-167; TM-514): mount + (re)load on entry, and re-enter when the profile sub-route
  // CHANGES (hub ↔ public preview) so the right layout renders, without refetching on the repeated
  // guard() calls for the same route (mirrors the events list↔detail re-entry).
  if (isProfileRoute(route)) {
    if (route !== profileRouteEntered) {
      profileRouteEntered = route;
      enterProfile(route);
    }
  } else {
    profileRouteEntered = null;
  }
  // Chat (TM-515): (re)enter whenever the chat route CHANGES (list vs a specific thread id) so
  // list↔thread↔another-thread navigation always repaints, without re-rendering on the repeated
  // guard() calls for the same route (mirrors the events list↔detail re-entry). enterChat(null) is the
  // list; enterChat(id) is a thread. Reset on leaving so re-entry re-renders.
  if (isChatRoute(route)) {
    if (route !== chatRouteEntered) {
      chatRouteEntered = route;
      enterChat(chatThreadId(route));
    }
  } else {
    chatRouteEntered = null;
  }
  // Notifications feed (TM-515): mount + rebuild the feed on entry, reset on leaving so a future entry
  // re-enters (mirrors the edit-profile view lifecycle).
  if (route === NOTIFICATIONS) {
    if (!notificationsActive) {
      notificationsActive = true;
      enterNotifications();
    }
  } else {
    notificationsActive = false;
  }
  // Membership tier screen (TM-606): mount + fetch the caller's membership on entry into #/membership,
  // reset on leaving so a future entry re-fetches. `route === MEMBERSHIP` is only ever true while the flag
  // is on (currentRoute gates it via isMembershipRoute), and a signed-out user is already bounced to login
  // by the isProtected() check above, so this only mounts for a signed-in user with the flag on. Same
  // mount-once lifecycle as the notifications feed.
  if (route === MEMBERSHIP) {
    if (!membershipActive) {
      membershipActive = true;
      enterMembershipTier();
    }
  } else {
    membershipActive = false;
  }
  // Subscribe checkout (TM-620): mount + fetch on entry into #/membership/subscribe/{TIER}, reset on
  // leaving so a future entry re-fetches (and re-parses the tier from the hash). Same flag/auth
  // guarantees and mount-once lifecycle as the tier screen above.
  if (isMembershipSubscribeRoute(route)) {
    if (membershipSubscribeActive !== route) {
      membershipSubscribeActive = route;
      enterMembershipSubscribe();
    }
  } else {
    membershipSubscribeActive = null;
  }
  // Receipts / my-tickets screen (TM-624): mount + fetch the caller's orders on entry into #/receipts,
  // reset on leaving so a future entry re-fetches. `route === RECEIPTS` is only ever true while the flag
  // is on (currentRoute gates it via isReceiptsRoute), and a signed-out user is already bounced to login
  // by the isProtected() check above, so this only mounts for a signed-in user with the flag on. Same
  // mount-once lifecycle as the membership tier screen.
  if (route === RECEIPTS) {
    if (!receiptsActive) {
      receiptsActive = true;
      enterMembershipReceipts();
    }
  } else {
    receiptsActive = false;
  }
  // Home feed (TM-512): mount the "Events near you" feed / empty-home on entry into #/home, reset on
  // leaving so re-entering (e.g. tapping the Home tab after RSVPing elsewhere) re-fetches. Repeated
  // guard() calls for the same route (the 2–3 fired on load / auth-resolve) don't refetch while
  // homeActive stays true. The render() above already toggles the #auth-signed-in panel's visibility.
  if (route === HOME) {
    if (!homeActive) {
      homeActive = true;
      enterHome();
    }
  } else {
    homeActive = false;
  }
  // First-login gate view (TM-250): mount on entry, passing the `done` callback the gate invokes
  // after a successful submit. `done` flips our local onboarded flag (the server now reports it) and
  // re-guards, which moves the now-onboarded user on to their intended route / home.
  if (route === ONBOARDING) {
    if (!onboardingActive) {
      onboardingActive = true;
      enterOnboarding(onOnboardingComplete);
    }
  } else {
    onboardingActive = false;
  }
  // Terms acceptance gate view (TM-170): mount on entry, passing the `done` callback the gate invokes
  // after a successful acceptance. `done` flips our local needsTerms flag (the server now records this
  // version as accepted) and re-guards, which moves the now-accepted user on to their intended route.
  if (route === TERMS) {
    if (!termsActive) {
      termsActive = true;
      enterTerms(onTermsComplete);
    }
  } else {
    termsActive = false;
  }
  // Static Help view (TM-255): mount its content once on entry (idempotent — there's no per-visit
  // data to load), reset on leaving so a future entry re-mounts if needed.
  if (route === HELP) {
    if (!helpActive) {
      helpActive = true;
      enterHelp();
    }
  } else {
    helpActive = false;
  }
  // QA diagnostics view (TM-297): mount on entry; enterDiagnostics() also refreshes the live push/token
  // readout each call, so re-entering picks up a token registered after the first visit. Reset on leave.
  if (route === DIAGNOSTICS) {
    if (!diagnosticsActive) {
      diagnosticsActive = true;
      enterDiagnostics();
    }
  } else {
    diagnosticsActive = false;
  }
  // Events UI (TM-396): (re)enter when the events route CHANGES so list↔detail↔another-detail
  // navigation always shows fresh counts/state, without refetching on the repeated guard() calls for
  // the same route. enterEvents(null) is the list; enterEvents(id) is a detail. Reset on leaving.
  if (isEventsRoute(route)) {
    if (route !== eventsRouteEntered) {
      eventsRouteEntered = route;
      enterEvents(eventDetailId(route));
    }
  } else {
    eventsRouteEntered = null;
  }
}

/** Invoked by the onboarding gate once the user completes it (TM-250): drop the gate + re-route. */
function onOnboardingComplete() {
  isOnboarded = true;
  onboardingActive = false; // allow a future re-mount (e.g. a later sign-out → new gated user)
  // The profile gate flips the same server onboarding flag the tour gates on (TM-171): keep tours in
  // step so the first-run tour won't auto-pop right after the gate lifts.
  window.tmTours?.setOnboardingCompleted?.(true);
  guard();
}

/** Invoked by the terms gate once the user accepts (TM-170): drop the gate + re-route. */
function onTermsComplete() {
  needsTerms = false;
  termsActive = false; // allow a future re-mount (e.g. a later version bump → re-gated user)
  guard();
}

// How long to wait for the role + onboarding lookups before we stop blocking on them. In the Android
// WebView against real Firebase, the first `getIdToken()` (token exchange) and the `GET /me` that
// follow a custom-token sign-in can hang indefinitely (no rejection, just never settling) — and an
// un-timed `await` on them was the TM-307 dead-end: navigation off `#/login` never fired because the
// promise it waited on never settled. We guard NAVIGATION-FIRST below, so this is only a backstop for
// re-guarding with fresh role/onboarding values; if it doesn't arrive in time we proceed with the
// fail-safe defaults rather than stalling the user on the login card.
const ROLE_RESOLVE_TIMEOUT_MS = 8000;

// Resolve the role (from the token) AND onboarding + terms-acceptance state (from GET /me) so the
// admin route/nav, the first-login gate (TM-250) AND the terms gate (TM-170) decisions use fresh
// values. Used for auth-state changes (sign-in/out, reload restore, promotion).
//
// TM-307: navigation must NOT block on these lookups. Previously this `await`ed both BEFORE the first
// guard(), so a hanging token-exchange / `GET /me` in the Android WebView left the user stranded on
// `#/login` with no error (sign-in had succeeded, but the nav never fired). We now:
//   1. guard() IMMEDIATELY with the current cached role/onboarding values, so a confirmed signed-in
//      user is navigated off `#/login` straight away (worst case: a brand-new user briefly lands on
//      `#/home` and is then moved to `#/onboarding` when /me resolves — far better than a dead-end);
//   2. resolve role + onboarding in the BACKGROUND with a timeout, then re-guard with the fresh
//      values (this is what moves a not-yet-onboarded user to the gate, or an ADMIN to the console);
//   3. surface a visible error if the lookups actually fail/time out — never a silent stall.
async function resolveRoleThenGuard() {
  const user = currentUser();
  const signedIn = Boolean(user);
  // Signed-out: reset to safe defaults (no gate, non-admin) and skip the network calls entirely. The
  // non-admin verdict is definitive here (no session → no role to resolve), so mark it resolved (TM-733).
  if (!signedIn) {
    isAdmin = false;
    isOnboarded = true;
    needsTerms = false;
    roleResolved = true;
    guard();
    return;
  }
  // TM-721: pin the uid this resolution belongs to. If the account is SWITCHED (sign out of A, into B)
  // while the role/onboarding lookups are in flight, applying A's resolved values to B would show B the
  // wrong role/gate. Checking only "is someone signed in?" below missed this — B *is* signed in, just not
  // the same user — so we compare uids, not mere presence.
  const uid = user.uid;

  // Signed-in but the role for THIS session isn't known yet: hold the admin gate (don't bounce with a
  // spurious "Admins only." toast) until the background lookup below resolves it. A fresh sign-in or a
  // reload starts here (TM-733).
  roleResolved = false;

  // 1) NAVIGATE FIRST. Don't wait on the network — a confirmed signed-in user must leave `#/login`
  //    now, using whatever cached role/onboarding values we have (fail-safe: non-admin, not gated).
  guard();

  // 2) Resolve role + onboarding in the background, each with a timeout so a hung request can't keep
  //    us from ever applying the real values. Each fails safe independently:
  //     - role: non-admin (TM-141 — never strand a signed-in user on the login form).
  //     - onboarded: fail OPEN (true = not gated) so a /me hiccup can't trap a user behind the gate;
  //       the backend stays the real authority on what an un-onboarded account may actually do.
  const [adminOutcome, onboardedOutcome] = await Promise.all([
    settleOrFallback(getRole(), ROLE_RESOLVE_TIMEOUT_MS, "USER"),
    settleOrFallback(getMe(), ROLE_RESOLVE_TIMEOUT_MS, null),
  ]);

  // Bail if the user signed out OR switched to a different account while the lookups were in flight —
  // don't apply stale values or re-guard for a session that no longer exists (or is now someone else).
  // TM-721: compare the uid, not just "is anyone signed in", so an account switch mid-flight is caught.
  const now = currentUser();
  if (!now || now.uid !== uid) return;

  isAdmin = adminOutcome.value === "ADMIN";
  // The role is now resolved for this session (even a timeout resolves to the fail-safe non-admin
  // value): the admin gate may make its real decision from here on (TM-733).
  roleResolved = true;
  // Gated when first-run onboarding is incomplete OR the account has no valid stored phone (TM-880:
  // phone is mandatory, enforced as a first-use completion gate on ALL users — the same #/onboarding
  // gate, which now collects the phone; needsPhoneNumber also catches a legacy country-ambiguous bare
  // number, reusing the TM-781 confirm-country rule) OR the stored phone is not the account's
  // Firebase-VERIFIED number AND the grace period for re-verifying it is OVER.
  //
  // TM-932 shipped the verified-phone re-gate as an IMMEDIATE hard bounce (folded needsVerifiedPhone
  // straight into isOnboarded). TM-992 (decision C = GRACE, then FORCE) softens that: the verified-phone
  // term only gates once phoneReverifyDecision says HARD_GATE — i.e. there IS a configured deadline and
  // it has passed. Inside the grace window (or, the SAFE DEFAULT, when no deadline is configured at all)
  // the decision is GRACE_NUDGE and this term is a no-op here — the user stays un-gated and only sees the
  // dismissible nudge banner (phone-reverify-notice.js). So we never lock an existing user out before
  // product picks a date, and we hard-gate exactly on/after it.
  //
  // The verified number is NOT on /me (MeResponse carries only the self-reported phone); it lives on the
  // Firebase user — sourced here from the uid-pinned `now` (currentUser() at line 1060, the same session
  // the /me was resolved for), NOT a fresh currentUser() call. Still fails OPEN (true) on a degraded /me:
  // needsVerifiedPhone returns false on a null /me, so the reverify decision is NONE and every phone term
  // is a no-op then.
  const reverifyDecision = phoneReverifyDecision({
    needsReverify: needsVerifiedPhone(onboardedOutcome.value, now.phoneNumber),
    deadline: parseReverifyDeadline(reverifyDeadlineConfig()),
    now: Date.now(),
  });
  isOnboarded = onboardedOutcome.value
    ? Boolean(onboardedOutcome.value.onboardingCompleted) &&
      !needsPhoneNumber(onboardedOutcome.value) &&
      reverifyDecision !== ReverifyDecision.HARD_GATE
    : true;
  // Terms gate (TM-170): the SAME /me result tells us whether the user still needs to accept the
  // current terms version. The pure rule (terms-gate.js) fails open (false) on a null/degraded /me,
  // so a backend hiccup never traps a user behind the terms gate.
  needsTerms = needsTermsAcceptance(onboardedOutcome.value);

  // Hand the resolved onboarding flag to the tours module (TM-171) so the first-run tour gates on
  // the server's durable "already onboarded" state — reusing the /me we just fetched rather than
  // making tours.js pay a second round trip. Only seed on a real /me result; on a timeout/error we
  // leave it "unknown" so tours.js resolves it itself (or simply defers the auto-tour).
  if (onboardedOutcome.value) window.tmTours?.setOnboardingCompleted?.(isOnboarded);

  // 3) Surface a visible signal if the onboarding/role resolution failed or timed out, so a degraded
  //    backend never looks like a silent dead-end. We've still navigated the user into the app on the
  //    fail-safe defaults (no gate, non-admin), so this is a soft warning, not a hard block.
  if (adminOutcome.timedOut || onboardedOutcome.timedOut || adminOutcome.error || onboardedOutcome.error) {
    console.warn("[router] role/onboarding lookup degraded after sign-in:", {
      roleTimedOut: Boolean(adminOutcome.timedOut),
      meTimedOut: Boolean(onboardedOutcome.timedOut),
      roleError: adminOutcome.error?.message,
      meError: onboardedOutcome.error?.message,
    });
    toast("Signed in, but we couldn't fully load your profile. Some features may be limited.", {
      type: "error",
    });
  }

  // Re-guard with the fresh values: moves a not-yet-onboarded user to the gate, an ADMIN to the
  // console, etc. By now we're already off `#/login`, so this only refines where the user landed.
  guard();
}

window.addEventListener("hashchange", guard);
// Auth changes re-resolve the role then re-run the guard so views/nav follow immediately.
onAuthChanged(resolveRoleThenGuard);
// Ensure there's always a route in the URL bar, then guard once on load.
if (!window.location.hash) {
  window.location.replace(`${window.location.pathname}${window.location.search}${currentUser() ? HOME : LOGIN}`);
}
guard();
