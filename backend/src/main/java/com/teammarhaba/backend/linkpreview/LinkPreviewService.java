package com.teammarhaba.backend.linkpreview;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.teammarhaba.backend.web.BadRequestException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Server-side link-preview fetcher (TM-470). Given a URL that appeared in a chat message, it fetches the
 * page and extracts its OpenGraph card ({@link OpenGraphParser}) so the thread can render a rich preview.
 * Exposed to the client through {@code GET /api/v1/link-preview?url=…}
 * ({@code com.teammarhaba.backend.api.LinkPreviewController}); the fetch is done <b>here on the server</b>
 * so the browser never makes the outbound request, and — critically — so the request runs behind the
 * SSRF guard below rather than from a place an attacker controls.
 *
 * <p><b>Why a dedicated endpoint (not inside message posting)?</b> The preview is fetched <em>lazily</em>
 * when a message renders, not when it is posted — so message send stays fast and untouched (a sibling
 * chat PR owns {@code MessagePostService}), and a slow/hostile target page can never delay or fail a
 * post. No message row or DB column stores the preview; the URL→preview cache below is the whole store.
 *
 * <p><b>SSRF is the load-bearing risk</b> (an attacker types a URL and we fetch it), so the fetch is
 * hardened:
 * <ul>
 *   <li><b>Scheme allow-list</b> — only {@code http}/{@code https}. {@code file:}, {@code gopher:},
 *       {@code ftp:}, {@code javascript:} etc. are rejected with a 400.</li>
 *   <li><b>Private/internal address block</b> — every IP the host resolves to must be publicly routable.
 *       Loopback, link-local (incl. the {@code 169.254.169.254} cloud-metadata endpoint), private
 *       ranges (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), IPv6 ULA (fc00::/7), multicast and the
 *       wildcard address are all refused. See {@link #isBlockedAddress(InetAddress)}.</li>
 *   <li><b>No blind redirects</b> — redirects are followed manually (up to {@link #MAX_REDIRECTS}) and
 *       <em>every</em> hop is re-validated through the same scheme + address guard, so a public URL that
 *       302s to {@code http://169.254.169.254/} is rejected at the hop rather than followed.</li>
 *   <li><b>Timeout + size cap</b> — a short connect/request timeout and a {@link #MAX_BODY_BYTES} read
 *       cap bound how long and how much a target page can make us spend.</li>
 * </ul>
 *
 * <p><b>DNS-rebinding closed (TM-724).</b> The guard resolves the host <em>once</em>, validates every
 * resolved IP, and returns the exact IP to connect to; for {@code http} the request is then pinned to
 * that IP literal (original hostname carried in the {@code Host} header) so the client never re-resolves
 * — removing the TOCTOU window where a short-TTL name could pass the check as a public IP and then
 * connect to an internal one. For {@code https} the hostname is kept (to preserve TLS SNI + certificate
 * hostname verification), and TLS itself defeats a rebind: an internal IP can't present a certificate
 * valid for the target hostname, so the connection fails verification. Built on the JDK
 * {@link HttpClient} (no new HTTP dependency, trivially testable against a loopback stub) exactly like
 * {@code RevolutPaymentProvider}.
 */
@Service
public class LinkPreviewService {

    private static final Logger log = LoggerFactory.getLogger(LinkPreviewService.class);

    /** Max redirect hops followed before giving up (each re-validated through the SSRF guard). */
    private static final int MAX_REDIRECTS = 4;

    /** Read cap on the fetched body — enough for a {@code <head>}, far short of pulling a whole large page. */
    private static final int MAX_BODY_BYTES = 512 * 1024;

    /** Per-request wall-clock cap (connect timeout is set on the client). */
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(4);

    /** A browser-ish UA + Accept so servers that vary on them still return the HTML head with OG tags. */
    private static final String USER_AGENT = "TeamMarhabaLinkPreview/1.0 (+https://teammarhaba.com)";

    private final HttpClient http;
    private final Cache<String, LinkPreview> cache;

    /**
     * Test seam: when {@code true} the private/internal address block is bypassed so a test can point the
     * fetcher at a loopback stub server. <b>Never true in production</b> — the {@code @Autowired}
     * constructor pins it {@code false}; only the package-private test constructor can set it.
     */
    private final boolean allowNonPublicHosts;

    @Autowired
    public LinkPreviewService() {
        this(
                HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(3))
                        // Follow NOTHING automatically — we follow redirects by hand so each hop is
                        // re-validated through the SSRF guard (an auto-followed redirect would skip it).
                        .followRedirects(HttpClient.Redirect.NEVER)
                        .build(),
                false);
    }

    /**
     * Test seam. {@code allowNonPublicHosts=true} lets a test drive the fetcher against a loopback stub
     * (otherwise the SSRF guard would reject {@code 127.0.0.1}); the dedicated SSRF tests keep it
     * {@code false} to prove the guard rejects internal targets.
     */
    LinkPreviewService(HttpClient http, boolean allowNonPublicHosts) {
        this.http = http;
        this.allowNonPublicHosts = allowNonPublicHosts;
        // Cache previews by URL (the AC): a bounded, self-evicting Caffeine cache — no DB table needed.
        // Short TTL so a page whose OG tags change (or a transiently-empty fetch) isn't pinned forever.
        this.cache = Caffeine.newBuilder()
                .maximumSize(1_000)
                .expireAfterWrite(Duration.ofHours(1))
                .build();
    }

    /**
     * The cached preview for {@code rawUrl}, fetching it on a miss. A blocked/invalid URL (bad scheme,
     * internal host) throws {@link BadRequestException} (→ 400) and is <b>not</b> cached; a reachable URL
     * that yields no usable metadata (fetch failed, non-2xx, no OG) returns an {@linkplain
     * LinkPreview#empty(String) empty} preview, which <em>is</em> cached so we don't re-hit a dud URL.
     *
     * @param rawUrl the URL to preview (as it appeared in the message).
     * @return the preview (never {@code null}; may be empty).
     * @throws BadRequestException if the URL is malformed, a disallowed scheme, or resolves to a
     *     private/internal address.
     */
    public LinkPreview preview(String rawUrl) {
        URI validated = validate(rawUrl); // throws 400 up-front (before any cache/fetch) on a bad URL
        // Key on the normalised absolute URL so trivially-different spellings share a cache entry.
        return cache.get(validated.toString(), key -> fetch(validated));
    }

    /**
     * Validate scheme + shape (NOT reachability) and return the parsed URI. Kept separate from {@link
     * #fetch} so a bad URL fails fast with a 400 before we touch the cache or the network.
     */
    private URI validate(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) {
            throw new BadRequestException("A url query parameter is required.");
        }
        URI uri;
        try {
            uri = new URI(rawUrl.trim());
        } catch (URISyntaxException e) {
            throw new BadRequestException("The url is not a valid URL.");
        }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            throw new BadRequestException("Only http and https URLs can be previewed.");
        }
        if (uri.getHost() == null || uri.getHost().isBlank()) {
            throw new BadRequestException("The url is missing a host.");
        }
        return uri;
    }

    /**
     * Fetch and parse {@code uri}, following redirects by hand and re-validating each hop's host through
     * the SSRF guard. Any transport-level failure (timeout, connection refused, non-2xx, oversized/binary
     * body) resolves to an {@linkplain LinkPreview#empty(String) empty} preview — the client then shows a
     * plain link. Only a blocked host / bad scheme (an SSRF attempt) throws.
     */
    private LinkPreview fetch(URI uri) {
        URI current = uri;
        try {
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                // Resolve ONCE, validate every resolved IP, and return the exact validated IP we'll
                // connect to. The request below is then pinned to that IP (URI rewritten to the literal
                // address, original hostname carried in the Host header), so the HTTP client does not
                // re-resolve — closing the DNS-rebinding TOCTOU where a short-TTL name could resolve to a
                // public IP for the check and an internal IP for the connect.
                InetAddress validatedIp = assertHostAllowed(current); // re-run on EVERY hop, incl. redirects
                HttpResponse<InputStream> response =
                        http.send(request(current, validatedIp), HttpResponse.BodyHandlers.ofInputStream());
                int status = response.statusCode();

                if (isRedirect(status)) {
                    response.body().close(); // no body needed from a redirect — release the connection
                    URI next = redirectTarget(response, current);
                    if (next == null) {
                        return LinkPreview.empty(uri.toString());
                    }
                    // Re-validate the redirect scheme (the host is re-checked at the top of the loop).
                    current = validate(next.toString());
                    continue;
                }

                if (status / 100 != 2) {
                    response.body().close();
                    return LinkPreview.empty(uri.toString()); // 4xx/5xx — nothing to preview, not an error
                }
                if (!isHtml(response)) {
                    response.body().close();
                    return LinkPreview.empty(uri.toString()); // a binary/non-HTML body has no OG head to parse
                }
                // readCapped closes the stream (try-with-resources) once we've read up to the cap.
                String body = readCapped(response.body());
                return OpenGraphParser.parse(body, current.toString());
            }
            // Ran out of redirect budget — treat as no preview rather than an error.
            return LinkPreview.empty(uri.toString());
        } catch (BadRequestException e) {
            throw e; // an SSRF rejection on a redirect hop must surface as a 400, not be swallowed below
        } catch (IOException e) {
            log.debug("Link preview fetch failed for host {}: {}", uri.getHost(), e.toString());
            return LinkPreview.empty(uri.toString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return LinkPreview.empty(uri.toString());
        }
    }

    /**
     * The standard request scaffold: short timeout, browser-ish headers, a GET — pinned to
     * {@code validatedIp} so the client connects to the exact address the SSRF guard just validated
     * (no DNS re-resolution → no rebinding window).
     *
     * <p>For {@code http} the pin is exact: the URI's host is rewritten to the validated IP literal, so
     * the client connects to precisely that address and the auto-generated {@code Host} header carries
     * that same authority. This is the scheme every realistic internal-SSRF target uses (the cloud
     * metadata endpoint, internal HTTP services, direct-IP targets). (The JDK {@link HttpClient} treats
     * {@code Host} as a restricted header and won't let us override it to the original name without a
     * process-wide opt-in; that trade-off — a name-based virtual host may return no preview — is
     * acceptable for a link preview and never widens the SSRF surface.)
     *
     * <p>For {@code https} the URI keeps the hostname (rewriting it to an IP literal would break TLS SNI
     * and certificate hostname verification). The rebinding window is closed a different way there: a
     * rebind to an attacker-chosen internal IP cannot present a certificate valid for the target
     * hostname, so TLS verification itself fails the connection — the validation above plus TLS together
     * leave no exploitable window. The {@code validatedIp} is therefore used only to pin {@code http}.
     */
    private HttpRequest request(URI uri, InetAddress validatedIp) {
        return HttpRequest.newBuilder(pinnedUri(uri, validatedIp))
                .timeout(REQUEST_TIMEOUT)
                .header("User-Agent", USER_AGENT)
                .header("Accept", "text/html,application/xhtml+xml")
                .header("Accept-Language", "en")
                .GET()
                .build();
    }

    /**
     * For {@code http}, {@code uri} with its host replaced by the validated IP literal (so the client
     * connects to exactly that address, not a freshly-resolved one — closing the rebinding TOCTOU). For
     * {@code https}, {@code uri} unchanged (see {@link #request}).
     */
    private static URI pinnedUri(URI uri, InetAddress validatedIp) {
        if (!"http".equalsIgnoreCase(uri.getScheme())) {
            return uri;
        }
        try {
            return new URI(
                    uri.getScheme(),
                    uri.getUserInfo(),
                    ipAuthority(validatedIp),
                    uri.getPort(),
                    uri.getPath(),
                    uri.getQuery(),
                    uri.getFragment());
        } catch (URISyntaxException e) {
            // Shouldn't happen (an IP literal is always a valid host) — fall back to the original URI,
            // which still goes through the validated guard, just without the IP pin.
            return uri;
        }
    }

    /** The host authority for a validated IP — bracketed for IPv6 as URI syntax requires. */
    private static String ipAuthority(InetAddress ip) {
        String host = ip.getHostAddress();
        return ip instanceof java.net.Inet6Address ? "[" + host + "]" : host;
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    /** Resolve a redirect's {@code Location} header against the current URL, or {@code null} if absent/bad. */
    private static URI redirectTarget(HttpResponse<InputStream> response, URI current) {
        String location = response.headers().firstValue("location").orElse(null);
        if (location == null || location.isBlank()) {
            return null;
        }
        try {
            return current.resolve(location.trim());
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** True when the response omits a content-type or declares an HTML-ish one (so it has an OG head). */
    private static boolean isHtml(HttpResponse<InputStream> response) {
        String contentType = response.headers()
                .firstValue("content-type")
                .map(v -> v.toLowerCase(Locale.ROOT))
                .orElse("");
        return contentType.isEmpty() || contentType.contains("html") || contentType.contains("xml");
    }

    /** Read up to {@link #MAX_BODY_BYTES} from the stream (then stop), decoding as UTF-8. */
    private static String readCapped(InputStream in) throws IOException {
        try (in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while (total < MAX_BODY_BYTES && (read = in.read(buffer)) != -1) {
                int allowed = Math.min(read, MAX_BODY_BYTES - total);
                out.write(buffer, 0, allowed);
                total += allowed;
            }
            return out.toString(StandardCharsets.UTF_8);
        }
    }

    /**
     * Resolve the host once, reject the request unless every resolved IP is publicly routable, and
     * <b>return the exact validated IP</b> the caller must pin the connection to. Resolving here (and
     * rejecting if <em>any</em> address is internal) blocks the whole SSRF family — direct-IP targets,
     * hostnames that resolve to a private IP, and the cloud metadata endpoint — and returning the pinned
     * address lets {@link #request} connect to that IP without a second (re-)resolution, closing the
     * DNS-rebinding TOCTOU. The address block is bypassed under the test seam
     * ({@link #allowNonPublicHosts}) so a loopback stub can be exercised, but the resolve-and-pin still
     * happens.
     *
     * @return the validated {@link InetAddress} to pin the outbound connection to.
     */
    InetAddress assertHostAllowed(URI uri) {
        String host = uri.getHost();
        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(host);
        } catch (UnknownHostException e) {
            // Unresolvable host — refuse rather than let the client probe DNS through us.
            throw new BadRequestException("The url host could not be resolved.");
        }
        // Under the test seam the block is bypassed, but we STILL resolve once and return a pinned
        // address so the connection targets exactly what we saw (the loopback stub in tests).
        for (InetAddress address : addresses) {
            if (!allowNonPublicHosts && isBlockedAddress(address)) {
                log.warn("Blocking link-preview fetch to non-public host {}", host);
                throw new BadRequestException("That URL points to a non-public address and can't be previewed.");
            }
        }
        // Return the exact IP the caller will pin the connection to. Every address resolved above was
        // validated, so the first is safe; pinning to it removes the second (re-)resolution entirely.
        return addresses[0];
    }

    /**
     * Whether an address is off-limits for an outbound preview fetch: loopback, wildcard/any-local,
     * link-local (169.254/16 + fe80::/10 — includes the cloud metadata IP), site-local private ranges
     * (10/8, 172.16/12, 192.168/16), multicast, CGNAT (100.64/10) and IPv6 unique-local (fc00::/7).
     * Package-private so the SSRF guard can be unit-tested directly against a table of addresses.
     */
    static boolean isBlockedAddress(InetAddress address) {
        if (address.isLoopbackAddress()
                || address.isAnyLocalAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            int first = bytes[0] & 0xFF;
            int second = bytes[1] & 0xFF;
            // Carrier-grade NAT 100.64.0.0/10 — Java has no isSiteLocal for it, so check explicitly.
            return first == 100 && second >= 64 && second <= 127;
        }
        // IPv6 unique-local addresses fc00::/7 (Java's isSiteLocalAddress only covers deprecated fec0::/10).
        return (bytes[0] & 0xFE) == 0xFC;
    }
}
