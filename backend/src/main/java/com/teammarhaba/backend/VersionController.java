package com.teammarhaba.backend;

import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Build provenance for "which build is actually live?" (TM-142). Public + unversioned, alongside
 * {@code /health} — the web first page fetches it to show the backend's build next to the web's,
 * so a stale surface is visible at a glance (motivated by the TM-131 stale-revision trap).
 *
 * <ul>
 *   <li>{@code version} — {@code git describe --tags} output (TM-155): a human-readable build
 *       name from the nearest release tag plus commits-since plus the SHA, e.g.
 *       {@code v1.4.0-12-ged338a9} ({@code BUILD_VERSION}, baked in via a Docker build-arg).
 *       Until anything is tagged it's the bare short SHA, and it falls back to {@code sha}
 *       (then {@code "dev"}) when run outside the image.</li>
 *   <li>{@code sha} — the exact git commit the image was built from ({@code BUILD_SHA}, baked in
 *       via a Docker build-arg from {@code GITHUB_SHA}; {@code "dev"} when run outside the image).
 *       Kept alongside {@code version} as the precise machine anchor.</li>
 *   <li>{@code buildTime} — from Spring Boot {@code build-info} ({@code "unknown"} if absent).</li>
 *   <li>{@code revision} — the Cloud Run serving revision ({@code K_REVISION}; {@code "local"}
 *       off Cloud Run), so the live revision is identifiable without the console.</li>
 * </ul>
 */
@RestController
public class VersionController {

    private final String version;
    private final String sha;
    private final String revision;
    private final BuildProperties buildProperties;

    VersionController(ObjectProvider<BuildProperties> buildProperties) {
        this.sha = orDefault(System.getenv("BUILD_SHA"), "dev");
        // git describe; falls back to the bare SHA when the build-arg is absent (local runs).
        this.version = orDefault(System.getenv("BUILD_VERSION"), this.sha);
        this.revision = orDefault(System.getenv("K_REVISION"), "local");
        this.buildProperties = buildProperties.getIfAvailable();
    }

    @GetMapping(value = "/version", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, String> version() {
        String buildTime = (buildProperties != null && buildProperties.getTime() != null)
                ? buildProperties.getTime().toString()
                : "unknown";
        return Map.of("version", version, "sha", sha, "buildTime", buildTime, "revision", revision);
    }

    private static String orDefault(String value, String fallback) {
        return (value == null || value.isBlank()) ? fallback : value;
    }
}
