package com.teammarhaba.backend.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.config.annotation.ContentNegotiationConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Keeps the HTTP API JSON-only (TM-126).
 *
 * <p>A Jackson <strong>XML</strong> message converter rides in transitively (jackson-dataformat-xml,
 * pulled via springdoc), so without this a browser's {@code Accept: application/xml} got XML back —
 * e.g. {@code /health} rendered as {@code <Map><status>UP</status></Map>}. That's inconsistent with
 * the JSON / RFC&nbsp;7807 contract the clients expect.
 *
 * <p>The fix is to <strong>ignore the request {@code Accept} header</strong> and always default to
 * JSON: every endpoint answers JSON regardless of what the caller prefers (so a browser gets JSON,
 * not XML, and not a {@code 406} from removing the converter). The XML library stays on the
 * classpath for any internal use (e.g. springdoc) — we just never negotiate HTTP responses to it.
 * Error responses keep their explicit {@code application/problem+json} media type (TM-72).
 */
@Configuration
public class WebJsonConfig implements WebMvcConfigurer {

    @Override
    public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {
        configurer.ignoreAcceptHeader(true).defaultContentType(MediaType.APPLICATION_JSON);
    }
}
