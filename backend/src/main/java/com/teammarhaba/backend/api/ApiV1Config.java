package com.teammarhaba.backend.api;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.HandlerTypePredicate;
import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Roots every application API controller under {@code /api/v1}, so a future breaking
 * change can ship as {@code /api/v2} without disturbing existing clients.
 *
 * <p>The prefix is applied <b>by package</b>: any controller under
 * {@code com.teammarhaba.backend.api} is served beneath {@code /api/v1}. Health probes
 * (e.g. {@code /health}, which the Cloud Run deploy probes), actuator, and API docs live
 * <b>outside</b> this package and stay unversioned — they are infrastructure, not the
 * versioned API surface.
 *
 * <p>To introduce v2 later: add a sibling configurer prefixing a new
 * {@code com.teammarhaba.backend.api.v2} package with {@code /api/v2} and add controllers
 * there; {@code /api/v1} keeps serving in parallel. Building v2 itself is out of scope here.
 */
@Configuration
public class ApiV1Config implements WebMvcConfigurer {

    /** Application API controllers under this package are served beneath {@code /api/v1}. */
    static final String API_BASE_PACKAGE = "com.teammarhaba.backend.api";

    @Override
    public void configurePathMatch(PathMatchConfigurer configurer) {
        configurer.addPathPrefix("/api/v1", HandlerTypePredicate.forBasePackage(API_BASE_PACKAGE));
    }
}
