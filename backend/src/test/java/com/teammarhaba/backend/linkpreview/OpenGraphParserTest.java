package com.teammarhaba.backend.linkpreview;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Unit tests for the pure OpenGraph extractor (TM-470) — no network, just HTML → {@link LinkPreview}.
 * Covers the field priority chain, attribute-order/quote tolerance, entity decoding, length clamping,
 * relative-image resolution and the non-http(s) image drop.
 */
class OpenGraphParserTest {

    private static final String PAGE = "https://example.com/articles/hello";

    @Test
    void extractsOpenGraphTitleDescriptionAndAbsoluteImage() {
        String html =
                """
                <html><head>
                  <meta property="og:title" content="Hello World">
                  <meta property="og:description" content="A friendly greeting.">
                  <meta property="og:image" content="https://cdn.example.com/hero.png">
                </head><body>ignored</body></html>
                """;

        LinkPreview preview = OpenGraphParser.parse(html, PAGE);

        assertThat(preview.title()).isEqualTo("Hello World");
        assertThat(preview.description()).isEqualTo("A friendly greeting.");
        assertThat(preview.imageUrl()).isEqualTo("https://cdn.example.com/hero.png");
        assertThat(preview.url()).isEqualTo(PAGE);
    }

    @Test
    void toleratesContentBeforePropertyAndSingleQuotes() {
        String html = "<meta content='Reversed &amp; quoted' property='og:title'>";

        LinkPreview preview = OpenGraphParser.parse(html, PAGE);

        // Attribute order doesn't matter, single quotes are accepted, and &amp; is decoded.
        assertThat(preview.title()).isEqualTo("Reversed & quoted");
    }

    @Test
    void fallsBackToTwitterThenTitleElementAndMetaDescription() {
        String html =
                """
                <head>
                  <title>Doc Title</title>
                  <meta name="twitter:image" content="https://cdn.example.com/t.png">
                  <meta name="description" content="Standard meta description.">
                </head>
                """;

        LinkPreview preview = OpenGraphParser.parse(html, PAGE);

        assertThat(preview.title()).isEqualTo("Doc Title"); // no og:/twitter: title → <title>
        assertThat(preview.description()).isEqualTo("Standard meta description.");
        assertThat(preview.imageUrl()).isEqualTo("https://cdn.example.com/t.png");
    }

    @Test
    void resolvesRelativeImageAgainstPageUrl() {
        String html = "<meta property=\"og:title\" content=\"T\"><meta property=\"og:image\" content=\"/img/pic.jpg\">";

        LinkPreview preview = OpenGraphParser.parse(html, PAGE);

        assertThat(preview.imageUrl()).isEqualTo("https://example.com/img/pic.jpg");
    }

    @Test
    void dropsNonHttpImage() {
        String html =
                "<meta property=\"og:title\" content=\"T\"><meta property=\"og:image\" content=\"data:image/png;base64,AAAA\">";

        LinkPreview preview = OpenGraphParser.parse(html, PAGE);

        assertThat(preview.title()).isEqualTo("T");
        assertThat(preview.imageUrl()).isNull(); // a data:/js: image is never surfaced
    }

    @Test
    void emptyOrMetadatalessHtmlYieldsEmptyPreview() {
        assertThat(OpenGraphParser.parse("", PAGE).hasContent()).isFalse();
        LinkPreview none = OpenGraphParser.parse("<html><body>no head tags here</body></html>", PAGE);
        assertThat(none.title()).isNull();
        assertThat(none.hasContent()).isFalse();
    }

    @Test
    void clampsOverlongTitle() {
        String longTitle = "x".repeat(500);
        String html = "<meta property=\"og:title\" content=\"" + longTitle + "\">";

        LinkPreview preview = OpenGraphParser.parse(html, PAGE);

        assertThat(preview.title()).hasSizeLessThanOrEqualTo(300);
        assertThat(preview.title()).endsWith("…");
    }
}
