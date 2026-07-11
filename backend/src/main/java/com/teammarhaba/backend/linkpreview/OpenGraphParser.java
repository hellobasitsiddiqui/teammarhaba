package com.teammarhaba.backend.linkpreview;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure OpenGraph / HTML metadata extractor (TM-470). Turns a fetched HTML document into a
 * {@link LinkPreview} — no network, no Spring, so it is trivially unit-tested in isolation
 * ({@code OpenGraphParserTest}), exactly like the codebase's other pure cores.
 *
 * <p>Extraction, in priority order per field:
 * <ul>
 *   <li><b>title</b> — {@code og:title} → {@code twitter:title} → the {@code <title>} element.</li>
 *   <li><b>description</b> — {@code og:description} → {@code twitter:description} → {@code <meta name="description">}.</li>
 *   <li><b>image</b> — {@code og:image} → {@code og:image:url} → {@code twitter:image}, resolved to an
 *       absolute {@code http}/{@code https} URL against the page URL (a relative or non-http(s) image is
 *       dropped rather than surfaced — it would be a broken or unsafe {@code <img src>} on the client).</li>
 * </ul>
 *
 * <p>Deliberately regex-based rather than pulling in an HTML parser dependency: we only need a handful of
 * {@code <meta>} tags from the document head, the values are length-clamped, and the output is inert data
 * (rendered as text / an image src by the client, never as HTML), so a lenient scan is sufficient and
 * keeps the backend dependency-free. Robust to attribute order ({@code content} before or after
 * {@code property}) and to single- or double-quoted attributes.
 */
final class OpenGraphParser {

    private OpenGraphParser() {}

    /** Clamp caps — a preview is a teaser, and unbounded strings are a memory/AbUse foot-gun. */
    private static final int TITLE_MAX = 300;

    private static final int DESCRIPTION_MAX = 600;

    private static final int URL_MAX = 2048;

    /** One {@code <meta ...>} tag (self-closing or not); we then read its attributes individually. */
    private static final Pattern META_TAG = Pattern.compile("<meta\\b[^>]*>", Pattern.CASE_INSENSITIVE);

    /** The {@code <title>…</title>} element text (DOTALL so a title spanning newlines still matches). */
    private static final Pattern TITLE_TAG =
            Pattern.compile("<title\\b[^>]*>(.*?)</title>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    /**
     * Parse {@code html} into a preview for {@code pageUrl}. Never throws on malformed markup — anything
     * it can't find is simply absent from the result (an {@link LinkPreview#empty(String)} in the limit).
     *
     * @param html the fetched document (may be partial — the fetcher caps the body size).
     * @param pageUrl the (final, post-redirect) URL the document was fetched from — the base for
     *     resolving a relative {@code og:image}.
     * @return the extracted preview (fields nullable).
     */
    static LinkPreview parse(String html, String pageUrl) {
        if (html == null || html.isBlank()) {
            return LinkPreview.empty(pageUrl);
        }

        // Collect every <meta> tag's (property|name) -> content once, lower-casing the key so lookups are
        // case-insensitive. First value wins for a repeated key (the document-order first is the canonical).
        Map<String, String> metas = collectMetaTags(html);

        String title = firstNonBlank(metas.get("og:title"), metas.get("twitter:title"), titleElement(html));
        String description =
                firstNonBlank(metas.get("og:description"), metas.get("twitter:description"), metas.get("description"));
        String rawImage = firstNonBlank(metas.get("og:image"), metas.get("og:image:url"), metas.get("twitter:image"));

        return new LinkPreview(
                pageUrl,
                clamp(title, TITLE_MAX),
                clamp(description, DESCRIPTION_MAX),
                clamp(absoluteHttpImage(rawImage, pageUrl), URL_MAX));
    }

    /** Read every {@code <meta>} tag into a first-wins {@code key -> content} map (keys lower-cased). */
    private static Map<String, String> collectMetaTags(String html) {
        Map<String, String> metas = new LinkedHashMap<>();
        Matcher tags = META_TAG.matcher(html);
        while (tags.find()) {
            String tag = tags.group();
            // OpenGraph uses `property="og:*"`; twitter/standard meta use `name="…"`. Accept either.
            String key = firstNonBlank(attr(tag, "property"), attr(tag, "name"));
            String content = attr(tag, "content");
            if (key != null && content != null) {
                metas.putIfAbsent(key.trim().toLowerCase(Locale.ROOT), decodeEntities(content));
            }
        }
        return metas;
    }

    /** The decoded, trimmed {@code <title>} element text, or {@code null} when absent/empty. */
    private static String titleElement(String html) {
        Matcher m = TITLE_TAG.matcher(html);
        if (m.find()) {
            String text = decodeEntities(m.group(1)).trim();
            return text.isEmpty() ? null : text;
        }
        return null;
    }

    /** Read one attribute's value from a tag (single- or double-quoted), or {@code null} when absent. */
    private static String attr(String tag, String name) {
        Matcher m = Pattern.compile(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", Pattern.CASE_INSENSITIVE)
                .matcher(tag);
        if (m.find()) {
            return m.group(1) != null ? m.group(1) : m.group(2);
        }
        return null;
    }

    /**
     * Resolve a raw {@code og:image} to an absolute {@code http}/{@code https} URL against the page URL,
     * or {@code null} if it can't be (a relative image on an unparseable base, or a non-http(s) scheme
     * such as {@code data:}/{@code javascript:} — those are dropped so the client never emits an unsafe
     * or broken {@code <img src>}).
     */
    private static String absoluteHttpImage(String rawImage, String pageUrl) {
        if (rawImage == null || rawImage.isBlank()) {
            return null;
        }
        try {
            URI resolved = URI.create(pageUrl).resolve(rawImage.trim());
            String scheme = resolved.getScheme();
            if (scheme != null && (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
                return resolved.toString();
            }
        } catch (RuntimeException e) {
            // Malformed image URL — treat as no image rather than propagating.
        }
        return null;
    }

    /** Decode the handful of HTML entities that show up in title/description text; leave the rest verbatim. */
    private static String decodeEntities(String value) {
        if (value == null || value.indexOf('&') < 0) {
            return value;
        }
        String out = value.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&#x27;", "'")
                .replace("&apos;", "'")
                .replace("&nbsp;", " ");
        return out;
    }

    /** Trim, then truncate to {@code max} chars (with an ellipsis) so a preview field is always bounded. */
    private static String clamp(String value, int max) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (trimmed.length() <= max) {
            return trimmed;
        }
        return trimmed.substring(0, max - 1).stripTrailing() + "…";
    }

    /** First argument that is non-null and non-blank, or {@code null} when all are. */
    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return null;
    }
}
