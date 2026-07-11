package com.teammarhaba.backend.linkpreview;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.teammarhaba.backend.web.BadRequestException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Tests for the SSRF-hardened link-preview fetcher (TM-470).
 *
 * <p>Two layers, mirroring the risk:
 * <ul>
 *   <li><b>The SSRF guard</b> — {@link LinkPreviewService#isBlockedAddress} over a table of internal vs
 *       public addresses, and {@code preview(...)} rejecting disallowed schemes and internal hosts with a
 *       400 <em>before any network call</em>. These run with the private-address block ACTIVE
 *       ({@code allowNonPublicHosts=false}).</li>
 *   <li><b>The happy path</b> — a real fetch against a loopback {@link HttpServer} stub (so no live
 *       internet), which requires the block to be bypassed via the test-only seam; covers OG extraction,
 *       manual redirect following (and rejecting a redirect to a bad scheme), non-2xx / non-HTML → empty,
 *       the body size cap, and URL caching.</li>
 * </ul>
 */
class LinkPreviewServiceTest {

    private HttpServer server;
    private String base;
    private final Map<String, Route> routes = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();

    private record Route(int status, String contentType, String location, String body) {}

    @BeforeEach
    void startStub() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            hits.computeIfAbsent(path, k -> new AtomicInteger()).incrementAndGet();
            Route route = routes.get(path);
            if (route == null) {
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
                return;
            }
            respond(exchange, route);
        });
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopStub() {
        server.stop(0);
    }

    private static void respond(HttpExchange exchange, Route route) throws IOException {
        if (route.location() != null) {
            exchange.getResponseHeaders().set("Location", route.location());
        }
        if (route.contentType() != null) {
            exchange.getResponseHeaders().set("Content-Type", route.contentType());
        }
        byte[] body = route.body() == null ? new byte[0] : route.body().getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(route.status(), body.length == 0 ? -1 : body.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(body);
        }
    }

    private void serveHtml(String path, String html) {
        routes.put(path, new Route(200, "text/html; charset=utf-8", null, html));
    }

    /** A service pointed at the loopback stub (the private-address block bypassed for the local test). */
    private LinkPreviewService loopbackService() {
        return new LinkPreviewService(
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build(), true);
    }

    /** A service with the SSRF block ACTIVE — the real production guard. */
    private LinkPreviewService guardedService() {
        return new LinkPreviewService(
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build(), false);
    }

    // ---------------------------------------------------------------- SSRF guard (block active)

    @Test
    void blocksInternalAndPrivateAddresses() throws UnknownHostException {
        for (String ip : new String[] {
            "127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1",
            "169.254.169.254", "0.0.0.0", "100.64.0.1", "100.127.255.255",
            "::1", "fd12:3456:789a::1", "fe80::1", "224.0.0.1"
        }) {
            assertThat(LinkPreviewService.isBlockedAddress(InetAddress.getByName(ip)))
                    .as("%s must be blocked", ip)
                    .isTrue();
        }
    }

    @Test
    void allowsPublicAddresses() throws UnknownHostException {
        for (String ip : new String[] {"8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111"}) {
            assertThat(LinkPreviewService.isBlockedAddress(InetAddress.getByName(ip)))
                    .as("%s must be allowed", ip)
                    .isFalse();
        }
    }

    @Test
    void rejectsDisallowedSchemes() {
        LinkPreviewService service = guardedService();
        assertThatThrownBy(() -> service.preview("file:///etc/passwd")).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> service.preview("ftp://example.com/x")).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> service.preview("javascript:alert(1)")).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> service.preview("  ")).isInstanceOf(BadRequestException.class);
    }

    @Test
    void rejectsInternalHostsBeforeConnecting() {
        LinkPreviewService service = guardedService();
        // Loopback + the cloud-metadata link-local address are refused with a 400 — never fetched.
        assertThatThrownBy(() -> service.preview("http://127.0.0.1/")).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> service.preview("http://169.254.169.254/latest/meta-data/"))
                .isInstanceOf(BadRequestException.class);
    }

    // ---------------------------------------------------------------- happy path (loopback stub)

    @Test
    void fetchesOpenGraphCardFromReachablePage() {
        serveHtml(
                "/article",
                """
                <html><head>
                  <meta property="og:title" content="Great Read">
                  <meta property="og:description" content="Worth your time.">
                  <meta property="og:image" content="https://cdn.example.com/pic.png">
                </head></html>
                """);

        LinkPreview preview = loopbackService().preview(base + "/article");

        assertThat(preview.title()).isEqualTo("Great Read");
        assertThat(preview.description()).isEqualTo("Worth your time.");
        assertThat(preview.imageUrl()).isEqualTo("https://cdn.example.com/pic.png");
        assertThat(preview.hasContent()).isTrue();
    }

    @Test
    void followsRedirectToFinalPage() {
        routes.put("/go", new Route(302, null, base + "/dest", null));
        serveHtml("/dest", "<meta property=\"og:title\" content=\"After Redirect\">");

        LinkPreview preview = loopbackService().preview(base + "/go");

        assertThat(preview.title()).isEqualTo("After Redirect");
        assertThat(preview.url()).isEqualTo(base + "/dest"); // resolved to the final URL
        assertThat(hits.get("/dest").get()).isEqualTo(1);
    }

    @Test
    void rejectsRedirectToDisallowedScheme() {
        // Even with the host block bypassed for the loopback stub, a redirect to a non-http(s) scheme is
        // still refused — proving redirect targets are re-validated, not blindly followed.
        routes.put("/evil", new Route(302, null, "ftp://attacker.example/", null));

        assertThatThrownBy(() -> loopbackService().preview(base + "/evil")).isInstanceOf(BadRequestException.class);
    }

    @Test
    void nonSuccessOrNonHtmlYieldsEmptyPreview() {
        routes.put("/missing", new Route(404, "text/html", null, "nope"));
        routes.put("/binary", new Route(200, "image/png", null, "PNG..."));

        LinkPreviewService service = loopbackService();
        assertThat(service.preview(base + "/missing").hasContent()).isFalse();
        assertThat(service.preview(base + "/binary").hasContent()).isFalse();
    }

    @Test
    void readsPastNothingButCapsHugeBodies() {
        // og:title sits in the head, then ~1MB of padding (well past the 512KB cap): the fetch must still
        // parse the early tag and complete without reading (or buffering) the whole body.
        String html = "<meta property=\"og:title\" content=\"Capped\">" + "x".repeat(1_000_000);
        serveHtml("/big", html);

        LinkPreview preview = loopbackService().preview(base + "/big");

        assertThat(preview.title()).isEqualTo("Capped");
    }

    @Test
    void cachesPreviewsByUrl() {
        serveHtml("/cached", "<meta property=\"og:title\" content=\"Once\">");
        LinkPreviewService service = loopbackService();

        LinkPreview first = service.preview(base + "/cached");
        LinkPreview second = service.preview(base + "/cached");

        assertThat(first.title()).isEqualTo("Once");
        assertThat(second.title()).isEqualTo("Once");
        // The second call is served from the URL cache — the stub was hit exactly once.
        assertThat(hits.get("/cached").get()).isEqualTo(1);
    }
}
