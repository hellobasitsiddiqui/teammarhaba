package com.teammarhaba.backend.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Strongly-typed, validated application configuration bound from {@code app.*}.
 *
 * <p>Bean Validation runs at bind time, so missing or blank required values fail
 * startup with a clear message rather than surfacing later as an NPE. The values
 * mirror the {@code .env.example} contract (TM-62): {@code dev}/{@code test}
 * supply safe defaults, while {@code prod} sources every value from the
 * environment with no fallback (see {@code application-prod.yml}).
 *
 * <p>The DB fields are the connection contract; the JDBC {@code DataSource} bean
 * itself lands with the data layer (Flyway, TM-71) — there is no driver yet.
 */
@Validated
@ConfigurationProperties(prefix = "app")
public record AppProperties(@Valid Db db, @Valid Firebase firebase) {

    /** Cloud SQL / Postgres connection settings (reached via the Auth Proxy socket). */
    public record Db(
            @NotBlank String name,
            @NotBlank String user,
            @NotBlank String password,
            @NotBlank String instanceConnectionName) {}

    /**
     * Firebase project used to verify Auth ID tokens, plus the Cloud Storage bucket the chat-media
     * signed-URL path (TM-1126) mints URLs against.
     *
     * <p>{@code storageBucket} is <strong>optional</strong> (nullable, not {@code @NotBlank}): the
     * bulk of the backend — auth token verification (TM-79) and push (TM-284) — needs only the
     * project id, and dev/test/CI boot with no Storage at all. Only the chat-media endpoint requires
     * it; when it is unset that single feature refuses cleanly (the service raises a clear error)
     * rather than the whole app failing to start. Prod sets it from the environment
     * ({@code app.firebase.storage-bucket}) to the real bucket (e.g. {@code teammarhaba.firebasestorage.app}).
     */
    public record Firebase(@NotBlank String projectId, String storageBucket) {}
}
