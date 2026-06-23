package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.teammarhaba.backend.AbstractIntegrationTest;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/**
 * OpenAPI spec drift guard (TM-135). Boots the app, fetches the springdoc-generated
 * {@code /v3/api-docs} document, canonicalises it, and asserts it matches the committed
 * {@code backend/openapi.json}. Any REST API change therefore has to be regenerated and
 * committed — making the contract change visible in the diff and reviewable — or the build
 * fails. It runs inside {@code mvn verify} (the existing CI gate), so it guards every PR with
 * no extra job and no browser/cloud.
 *
 * <p><strong>Changed the API?</strong> Regenerate the committed spec and commit it:
 * <pre>./mvnw -pl backend -Dtest=OpenApiDriftTest -Dopenapi.generate=true -Dspotless.check.skip=true test</pre>
 * (also in {@code CONTRIBUTING.md}). The {@code openapi.generate} system property switches this
 * test from <em>assert</em> to <em>write</em> mode.
 *
 * <p>Canonicalisation reads the JSON into an order-insensitive tree and re-serialises it with
 * sorted keys + pretty printing, so the committed file is stable and diffs are meaningful
 * (not reordering noise). MockMvc (MOCK servlet env) gives a fixed {@code http://localhost}
 * server URL, so the document is deterministic across machines and CI.
 */
@AutoConfigureMockMvc
class OpenApiDriftTest extends AbstractIntegrationTest {

    /** Committed spec — relative to the backend module dir (the Maven working dir). */
    private static final Path SPEC = Path.of("openapi.json");

    private static final ObjectMapper CANONICAL = new ObjectMapper()
            .enable(SerializationFeature.INDENT_OUTPUT)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    @Autowired
    private MockMvc mockMvc;

    @Test
    void specMatchesCommittedOrRegenerates() throws Exception {
        String live = mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String canonical = canonicalise(live);

        if (Boolean.getBoolean("openapi.generate")) {
            Files.writeString(SPEC, canonical + System.lineSeparator());
            return; // regeneration mode: write the file and pass
        }

        assertThat(Files.exists(SPEC))
                .as("committed openapi.json is missing — regenerate with -Dopenapi.generate=true")
                .isTrue();
        assertThat(canonical)
                .as("OpenAPI spec drifted from committed openapi.json. If the API change is "
                        + "intentional, regenerate: ./mvnw -pl backend -Dtest=OpenApiDriftTest "
                        + "-Dopenapi.generate=true -Dspotless.check.skip=true test, then commit openapi.json.")
                .isEqualTo(canonicalise(Files.readString(SPEC)));
    }

    /** Parse to an order-insensitive tree and re-serialise with sorted keys — a stable canonical form. */
    private static String canonicalise(String json) throws Exception {
        return CANONICAL.writerWithDefaultPrettyPrinter()
                .writeValueAsString(CANONICAL.readValue(json, Object.class));
    }
}
