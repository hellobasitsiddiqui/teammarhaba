package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.user.Role;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Parsing + authority mapping for the {@code role} custom claim (TM-110). */
class RoleClaimsTest {

    @Test
    void parsesAdminAndUser() {
        assertThat(RoleClaims.roleFrom(Map.of("role", "ADMIN"))).isEqualTo(Role.ADMIN);
        assertThat(RoleClaims.roleFrom(Map.of("role", "USER"))).isEqualTo(Role.USER);
    }

    @Test
    void isCaseInsensitiveAndTrims() {
        assertThat(RoleClaims.roleFrom(Map.of("role", " admin "))).isEqualTo(Role.ADMIN);
    }

    @Test
    void defaultsToUserWhenAbsentBlankOrUnknown() {
        assertThat(RoleClaims.roleFrom(Map.of())).isEqualTo(Role.USER);
        assertThat(RoleClaims.roleFrom(Map.of("role", "root"))).isEqualTo(Role.USER);
        assertThat(RoleClaims.roleFrom(null)).isEqualTo(Role.USER);
    }

    @Test
    void defaultsToUserWhenClaimValueIsNull() {
        Map<String, Object> claims = new HashMap<>();
        claims.put("role", null);
        assertThat(RoleClaims.roleFrom(claims)).isEqualTo(Role.USER);
    }

    @Test
    void mapsRolesToSpringAuthorities() {
        assertThat(RoleClaims.authorities(Role.ADMIN))
                .extracting("authority")
                .containsExactly("ROLE_ADMIN");
        assertThat(RoleClaims.authorities(Role.USER))
                .extracting("authority")
                .containsExactly("ROLE_USER");
    }
}
