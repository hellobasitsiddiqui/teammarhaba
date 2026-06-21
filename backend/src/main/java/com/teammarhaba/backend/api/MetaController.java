package com.teammarhaba.backend.api;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Minimal versioned endpoint that anchors the {@code /api/v1} surface and gives clients a
 * stable place to read the API version. Served at {@code GET /api/v1/meta} — the
 * {@code /api/v1} prefix is applied by {@link ApiV1Config} (this controller declares only
 * {@code /meta}). It is also the conformance example for the versioning convention.
 */
@RestController
public class MetaController {

    @GetMapping("/meta")
    public Map<String, String> meta() {
        return Map.of("api", "teammarhaba-backend", "version", "v1");
    }
}
