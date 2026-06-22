package com.teammarhaba.backend.auth;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.config.AdminProperties;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.UserService;
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
 *   <li><b>Email set, claim already {@code ADMIN}</b> → the claim is left as-is, but the persisted
 *       {@code users.role} row is still reconciled to {@code ADMIN} via {@link UserService#syncRole}.
 *       This is what heals a row whose claim was set out-of-band <em>before</em> the DB-sync existed
 *       (TM-140): the early-return that used to skip this left {@code GET /api/v1/me} and the admin
 *       list showing a stale {@code USER}. Idempotent across restarts.</li>
 *   <li><b>Email set, user found</b> → writes the {@code ADMIN} role claim <em>and</em> the DB row via
 *       {@link RoleService}. The user must refresh their ID token to pick up the claim.</li>
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
    private final UserService userService;

    public AdminBootstrap(
            AdminProperties properties,
            ObjectProvider<FirebaseAuth> firebaseAuth,
            RoleService roleService,
            UserService userService) {
        this.properties = properties;
        this.firebaseAuth = firebaseAuth;
        this.roleService = roleService;
        this.userService = userService;
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
                // Claim already ADMIN — but the DB row may still be a stale USER if the claim was set
                // out-of-band (or before the DB-sync shipped). Reconcile the row so /me and the admin
                // list are correct; a plain no-op here is the TM-140 regression we are fixing.
                userService.syncRole(user.getUid(), Role.ADMIN);
                log.info("Bootstrap admin {} already has the ADMIN claim; reconciled the DB row.", trimmed);
                return;
            }
            roleService.assignRole(user.getUid(), Role.ADMIN);
            log.info("Bootstrap admin {} promoted to ADMIN (claim + DB row).", trimmed);
        } catch (Exception e) {
            // Pass the throwable as the trailing arg so the full exception (type + message + stack)
            // is logged — the email substitutes into {} (TM-140: this previously rendered literally,
            // hiding the real cause, e.g. the runtime SA missing roles/firebaseauth.admin).
            log.warn(
                    "Could not bootstrap admin '{}'. Ensure the account has signed in at least once "
                            + "(so it exists in Firebase Auth) and the runtime SA has firebaseauth.admin, then restart.",
                    trimmed,
                    e);
        }
    }
}
