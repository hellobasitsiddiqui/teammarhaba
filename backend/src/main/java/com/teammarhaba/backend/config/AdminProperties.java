package com.teammarhaba.backend.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Optional admin bootstrap configuration bound from {@code app.admin.*} (TM-110).
 *
 * <p>{@code bootstrapEmail} solves the first-admin chicken-and-egg: just-in-time provisioning
 * (TM-112) makes every new account a {@code USER}, and the set-role endpoint (TM-111) requires you
 * to already be an admin — so without a seed nobody could ever become the first admin. When set
 * (env {@code ADMIN_BOOTSTRAP_EMAIL}), the matching Firebase account is promoted to {@code ADMIN}
 * on startup ({@code AdminBootstrap}). It is <strong>optional and nullable</strong>: unset (the
 * dev/test/CI default) means no bootstrap runs and Firebase is never touched at boot. The value is
 * an email, not a hard-coded identity, so it survives a project rename/replay.
 */
@ConfigurationProperties(prefix = "app.admin")
public record AdminProperties(String bootstrapEmail) {}
