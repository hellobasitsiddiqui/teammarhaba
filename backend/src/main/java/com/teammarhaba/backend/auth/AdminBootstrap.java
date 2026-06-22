package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.config.AdminProperties;
import com.teammarhaba.backend.user.Role;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * Promotes the configured first admin to {@code ADMIN} on startup (TM-110) so the admin surface is
 * ever reachable — breaking the JIT-makes-everyone-USER (TM-112) vs. set-role-needs-admin (TM-111)
 * deadlock. Driven entirely by {@link AdminProperties#bootstrapEmail()} (env
 * {@code ADMIN_BOOTSTRAP_EMAIL}); there is no hard-coded identity.
 *
 * <p>Behaviour:
 * <ul>
 *   <li><b>No email configured</b> (dev/test/CI default) → returns immediately, <em>without</em>
 *       resolving {@link FirebaseAuth}, so boots with no ADC stay credential-free.</li>
 *   <li><b>Email set, user already {@code ADMIN}</b> → no-op (idempotent across restarts).</li>
 *   <li><b>Email set, user found</b> → writes the {@code ADMIN} role claim via {@link RoleService}.
 *       The user must refresh their ID token to pick it up.</li>
 *   <li><b>Email set, user not found / Admin SDK error</b> → logs a {@code WARN} and continues;
 *       startup is never failed by bootstrap. (Sign in once so the account exists, then restart.)</li>
 * </ul>
 */
@Component
public class AdminBootstrap implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminBootstrap.class);

    private final AdminProperties properties;
    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final RoleService roleService;

    public AdminBootstrap(
            AdminProperties properties,
            ObjectProvider<FirebaseAuth> firebaseAuth,
            RoleService roleService) {
        this.properties = properties;
        this.firebaseAuth = firebaseAuth;
        this.roleService = roleService;
    }

    @Override
    public void run(ApplicationArguments args) {
        String email = properties.bootstrapEmail();
        if (!StringUtils.hasText(email)) {
            return; // No bootstrap configured — never touch Firebase/ADC.
        }
        String trimmed = email.trim();
        try {
            UserRecord user = firebaseAuth.getObject().getUserByEmail(trimmed);
            if (RoleClaims.roleFrom(user.getCustomClaims()) == Role.ADMIN) {
                log.info("Bootstrap admin {} already has ADMIN; nothing to do.", trimmed);
                return;
            }
            roleService.assignRole(user.getUid(), Role.ADMIN);
            log.info("Bootstrap admin {} promoted to ADMIN.", trimmed);
        } catch (Exception e) {
            log.warn(
                    "Could not bootstrap admin '{}': {}. Ensure the account has signed in at least "
                            + "once (so it exists in Firebase Auth), then restart.",
                    trimmed,
                    e.getMessage());
        }
    }
}
