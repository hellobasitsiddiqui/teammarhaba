package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.device.DeviceTokenRepository;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/me/devices} (TM-283): an authenticated caller registers (idempotent upsert) and
 * deregisters their push device tokens; an anonymous caller gets the uniform {@code 401}. The
 * authenticated case injects a {@link VerifiedUser} principal directly (token verification is
 * exercised separately), mirroring {@link MeControllerIntegrationTest}.
 */
@AutoConfigureMockMvc
class DeviceControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private DeviceTokenRepository deviceTokens;

    @Autowired
    private UserRepository users;

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
}
