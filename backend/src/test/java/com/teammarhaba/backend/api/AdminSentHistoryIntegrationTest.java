package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.messaging.AdminMessage;
import com.teammarhaba.backend.messaging.AdminMessageRepository;
import com.teammarhaba.backend.messaging.TargetType;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin sent-history read API ({@code GET /api/v1/admin/messages}, TM-442, epic TM-432) end-to-end
 * through the real security chain + Postgres. Seeds {@code admin_message} campaign headers directly (the
 * append-only header table TM-441 owns — this read adds no schema) and asserts the ACs:
 *
 * <ul>
 *   <li><b>admin-gated</b> — anonymous → 401, a regular {@code USER} → 403;
 *   <li><b>newest-first, paged</b> — the shared {@link com.teammarhaba.backend.common.PageResponse}
 *       envelope, ordered {@code createdAt}/{@code id} desc, honouring {@code page}/{@code size};
 *   <li><b>per-actor scope</b> — the story is "messages <em>I've</em> sent", so a caller sees only their
 *       own campaigns and never another admin's;
 *   <li><b>each row's facts</b> — audience summary (type + count) + descriptor, sent-at, recipient
 *       count, and the derived delivery status (SENT for a real send, EMPTY only for a — never-produced
 *       — zero-recipient header);
 *   <li><b>sort is allow-listed</b> — an off-list {@code sort} property is a clean 400, not a 500.
 * </ul>
 */
@AutoConfigureMockMvc
class AdminSentHistoryIntegrationTest extends AbstractIntegrationTest {

    private static final String HISTORY = "/api/v1/admin/messages";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AdminMessageRepository adminMessages;

    // --- principals --------------------------------------------------------------------------------

    private static RequestPostProcessor admin(String uid) {
        return principal(uid, "ROLE_ADMIN");
    }

    private static RequestPostProcessor regularUser(String uid) {
        return principal(uid, "ROLE_USER");
    }

    private static RequestPostProcessor principal(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority(authority))));
    }

    // --- seeding -----------------------------------------------------------------------------------

    /** Append one campaign header for {@code actorUid} and return its DB-assigned id (created_at = now()). */
    private long seed(
            String actorUid,
            String title,
            String deepLink,
            TargetType targetType,
            String targetRef,
            int recipientCount) {
        return adminMessages
                .save(new AdminMessage(actorUid, title, "body of " + title, deepLink, targetType, targetRef, recipientCount))
                .getId();
    }

    // --- authorization -----------------------------------------------------------------------------

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(get(HISTORY))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void regularUserIsForbidden() throws Exception {
        mockMvc.perform(get(HISTORY).with(regularUser("plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    // --- ordering + per-row facts ------------------------------------------------------------------

    @Test
    void listsCallersCampaignsNewestFirstWithAudienceSummaryAndCounts() throws Exception {
        // Three sends by the same admin, one of each target type, appended oldest → newest.
        long first = seed("admin-hist", "City news", null, TargetType.CITY, "Bristol", 12);
        long second = seed("admin-hist", "Event reminder", "#/events/7", TargetType.EVENT, "7", 5);
        long third = seed("admin-hist", "Direct hello", "#/home", TargetType.USER, "1,2,3", 3);

        mockMvc.perform(get(HISTORY).with(admin("admin-hist")))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                // Newest first: the last appended campaign leads.
                .andExpect(jsonPath("$.items.length()").value(3))
                .andExpect(jsonPath("$.items[0].id").value((int) third))
                .andExpect(jsonPath("$.items[1].id").value((int) second))
                .andExpect(jsonPath("$.items[2].id").value((int) first))
                // The lead row's facts: audience summary (type + count), sent-at, recipient count, status.
                .andExpect(jsonPath("$.items[0].title").value("Direct hello"))
                .andExpect(jsonPath("$.items[0].sentByUid").value("admin-hist"))
                .andExpect(jsonPath("$.items[0].audienceType").value("USER"))
                .andExpect(jsonPath("$.items[0].audienceRef").value("1,2,3"))
                .andExpect(jsonPath("$.items[0].recipientCount").value(3))
                .andExpect(jsonPath("$.items[0].deepLink").value("#/home"))
                .andExpect(jsonPath("$.items[0].status").value("SENT"))
                .andExpect(jsonPath("$.items[0].sentAt").isNotEmpty())
                // The city send: type + count reflect the CITY audience; a null deep-link stays null.
                .andExpect(jsonPath("$.items[2].audienceType").value("CITY"))
                .andExpect(jsonPath("$.items[2].audienceRef").value("Bristol"))
                .andExpect(jsonPath("$.items[2].recipientCount").value(12))
                .andExpect(jsonPath("$.items[2].deepLink").value(org.hamcrest.Matchers.nullValue()))
                // Page envelope.
                .andExpect(jsonPath("$.page").value(0))
                .andExpect(jsonPath("$.totalElements").value(3))
                .andExpect(jsonPath("$.totalPages").value(1));
    }

    // --- per-actor scope ---------------------------------------------------------------------------

    @Test
    void scopedToTheCallingAdminOnly() throws Exception {
        long mine = seed("admin-me", "Mine", null, TargetType.USER, "9", 1);
        seed("admin-other", "Theirs", null, TargetType.USER, "8", 1); // a different admin's send

        mockMvc.perform(get(HISTORY).with(admin("admin-me")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].id").value((int) mine))
                .andExpect(jsonPath("$.items[0].sentByUid").value("admin-me"))
                .andExpect(jsonPath("$.totalElements").value(1));
    }

    @Test
    void adminWithNoSendsGetsAnEmptyPage() throws Exception {
        mockMvc.perform(get(HISTORY).with(admin("admin-fresh")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(0))
                .andExpect(jsonPath("$.totalElements").value(0))
                .andExpect(jsonPath("$.totalPages").value(0));
    }

    // --- paging ------------------------------------------------------------------------------------

    @Test
    void honoursPageAndSize() throws Exception {
        long a = seed("admin-page", "A", null, TargetType.USER, "1", 1);
        long b = seed("admin-page", "B", null, TargetType.USER, "2", 1);
        long c = seed("admin-page", "C", null, TargetType.USER, "3", 1); // newest

        // Page 0, size 2 → the two newest (C, B); envelope reports the full total across pages.
        mockMvc.perform(get(HISTORY).with(admin("admin-page")).param("page", "0").param("size", "2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2))
                .andExpect(jsonPath("$.items[0].id").value((int) c))
                .andExpect(jsonPath("$.items[1].id").value((int) b))
                .andExpect(jsonPath("$.page").value(0))
                .andExpect(jsonPath("$.size").value(2))
                .andExpect(jsonPath("$.totalElements").value(3))
                .andExpect(jsonPath("$.totalPages").value(2));

        // Page 1, size 2 → the remaining oldest (A).
        mockMvc.perform(get(HISTORY).with(admin("admin-page")).param("page", "1").param("size", "2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].id").value((int) a));
    }

    // --- derived status ----------------------------------------------------------------------------

    @Test
    void zeroRecipientHeaderDerivesEmptyStatus() throws Exception {
        // A header only ever exists for a committed send (empty audiences are rejected before insert,
        // TM-441), so this is a defensive case: assert the derived status reads EMPTY, never "SENT to nobody".
        seed("admin-zero", "Ghost", null, TargetType.CITY, "Nowheresville", 0);

        mockMvc.perform(get(HISTORY).with(admin("admin-zero")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].recipientCount").value(0))
                .andExpect(jsonPath("$.items[0].status").value("EMPTY"));
    }

    // --- sort allow-list ---------------------------------------------------------------------------

    @Test
    void offListSortPropertyIs400NotServerError() throws Exception {
        seed("admin-sort", "Whatever", null, TargetType.USER, "1", 1);

        mockMvc.perform(get(HISTORY).with(admin("admin-sort")).param("sort", "body"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Invalid request"))
                .andExpect(jsonPath("$.status").value(400));
    }
}
