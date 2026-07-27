package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/me/devices} (TM-283 + TM-924): an authenticated caller lists, registers (idempotent
 * upsert) and deregisters their push device tokens, and can "sign out everywhere"; an anonymous caller
 * gets the uniform {@code 401}. The authenticated case injects a {@link VerifiedUser} principal
 * directly (token verification is exercised separately), mirroring {@link MeControllerIntegrationTest}.
 *
 * <p>The sign-out-everywhere path (TM-924) reuses {@code FirebaseAuth.revokeRefreshTokens}; a
 * {@link MockBean} {@link FirebaseAuth} stands in for the Admin SDK (absent in CI) so the endpoint's
 * revoke call is observable ({@code verify(...).revokeRefreshTokens(uid)}) and the graceful-degrade
 * path is exercised without real credentials.
 */
@AutoConfigureMockMvc
class DeviceControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private DeviceTokenRepository deviceTokens;

    @Autowired
    private UserRepository users;

    /**
     * The Admin SDK bean isn't present in CI (no credentials). {@link SessionRevocationService} resolves
     * it lazily via an {@code ObjectProvider}; a mock here makes the sign-out-everywhere revoke call
     * observable and lets the degrade path run without ADC.
     */
    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    @Test
    void registerStoresTokenForCallerAndEchoesIt() throws Exception {
        mockMvc.perform(post("/api/v1/me/devices")
                        .with(caller("uid-dev-1", "ada@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"fcm-token-aaa\",\"platform\":\"ANDROID\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token").value("fcm-token-aaa"))
                .andExpect(jsonPath("$.platform").value("ANDROID"))
                .andExpect(jsonPath("$.updatedAt").exists());

        var saved = deviceTokens.findByToken("fcm-token-aaa").orElseThrow();
        Long userId = users.findByFirebaseUid("uid-dev-1").orElseThrow().getId();
        assertThat(saved.getUserId()).isEqualTo(userId);
        assertThat(saved.getPlatform().name()).isEqualTo("ANDROID");
    }

    @Test
    void registerIsIdempotentOnTokenAndRefreshesPlatform() throws Exception {
        var who = caller("uid-dev-idem", "grace@example.com");

        mockMvc.perform(post("/api/v1/me/devices")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"fcm-token-dup\",\"platform\":\"ANDROID\"}"))
                .andExpect(status().isOk());

        // Same token again with a different platform — must update in place, not duplicate.
        mockMvc.perform(post("/api/v1/me/devices")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"fcm-token-dup\",\"platform\":\"IOS\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.platform").value("IOS"));

        assertThat(deviceTokens.findAll().stream()
                        .filter(d -> d.getToken().equals("fcm-token-dup"))
                        .count())
                .isEqualTo(1);
        assertThat(deviceTokens.findByToken("fcm-token-dup").orElseThrow().getPlatform().name())
                .isEqualTo("IOS");
    }

    @Test
    void deregisterRemovesTheToken() throws Exception {
        var who = caller("uid-dev-del", "eve@example.com");

        mockMvc.perform(post("/api/v1/me/devices")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"fcm-token-del\",\"platform\":\"WEB\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(delete("/api/v1/me/devices/{token}", "fcm-token-del").with(who))
                .andExpect(status().isNoContent());

        assertThat(deviceTokens.findByToken("fcm-token-del")).isEmpty();
    }

    @Test
    void deregisterUnknownTokenIsIdempotentNoContent() throws Exception {
        mockMvc.perform(delete("/api/v1/me/devices/{token}", "never-registered")
                        .with(caller("uid-dev-none", "x@example.com")))
                .andExpect(status().isNoContent());
    }

    @Test
    void rejectsBlankTokenWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/devices")
                        .with(caller("uid-dev-blank", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"\",\"platform\":\"ANDROID\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsUnknownPlatformWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/devices")
                        .with(caller("uid-dev-badplat", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"fcm-token-bad\",\"platform\":\"BLACKBERRY\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsAnonymousWith401() throws Exception {
        mockMvc.perform(post("/api/v1/me/devices")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"fcm-token-anon\",\"platform\":\"ANDROID\"}"))
                .andExpect(status().isUnauthorized());
    }

    // --- TM-924: GET /me/devices — the "Your devices" list, scoped to the caller ------------------

    @Test
    void listReturnsOnlyTheCallersOwnDevicesWithPlatformAndTimestamps() throws Exception {
        var ada = caller("uid-list-ada", "ada@example.com");
        var eve = caller("uid-list-eve", "eve@example.com");

        // Ada registers two devices; Eve registers one — the list must never leak across accounts.
        mockMvc.perform(post("/api/v1/me/devices")
                        .with(ada)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"ada-web\",\"platform\":\"WEB\"}"))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/me/devices")
                        .with(ada)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"ada-android\",\"platform\":\"ANDROID\"}"))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/me/devices")
                        .with(eve)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"eve-ios\",\"platform\":\"IOS\"}"))
                .andExpect(status().isOk());

        // Ada sees exactly her two devices — platform + lastSeen + created, and NEVER the raw push token.
        mockMvc.perform(get("/api/v1/me/devices").with(ada).accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[*].platform", org.hamcrest.Matchers.containsInAnyOrder("WEB", "ANDROID")))
                .andExpect(jsonPath("$[0].lastSeen").exists())
                .andExpect(jsonPath("$[0].created").exists())
                .andExpect(jsonPath("$[0].id").exists())
                // The raw FCM token is a sender-usable credential — it must NOT be echoed in the list.
                .andExpect(jsonPath("$[0].token").doesNotExist());

        // Eve sees only her own single device — no cross-account leak.
        mockMvc.perform(get("/api/v1/me/devices").with(eve).accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].platform").value("IOS"));
    }

    @Test
    void listIsEmptyForACallerWithNoRegisteredDevices() throws Exception {
        // A push-less browser session has no device_tokens row — a 200 with [], never a 404.
        mockMvc.perform(get("/api/v1/me/devices")
                        .with(caller("uid-list-none", "nobody@example.com"))
                        .accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    void listRejectsAnonymousWith401() throws Exception {
        mockMvc.perform(get("/api/v1/me/devices").accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isUnauthorized());
    }

    // --- TM-924: POST /me/devices/sign-out-everywhere — revoke ALL of the caller's sessions --------

    @Test
    void signOutEverywhereRevokesTheCallersRefreshTokensAndReturns204() throws Exception {
        mockMvc.perform(post("/api/v1/me/devices/sign-out-everywhere")
                        .with(caller("uid-revoke-me", "revoke@example.com")))
                .andExpect(status().isNoContent());

        // The endpoint reuses the revokeRefreshTokens primitive against the CALLER's own uid (from the
        // verified token, never the client) — the fast-lockout filter then boots every session next request.
        verify(firebaseAuth).revokeRefreshTokens("uid-revoke-me");
    }

    @Test
    void signOutEverywhereRejectsAnonymousWith401() throws Exception {
        mockMvc.perform(post("/api/v1/me/devices/sign-out-everywhere")).andExpect(status().isUnauthorized());
    }
}
