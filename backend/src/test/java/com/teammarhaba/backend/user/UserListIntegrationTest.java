package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Validates the TM-115 list conventions against their first real consumer — the admin users
 * listing ({@link UserService#list}). Covers paging, the size cap, sorting, the optional filters,
 * and that soft-deleted accounts never appear.
 */
class UserListIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserService userService;

    @Autowired
    private UserRepository users;

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void seed() {
        // Clean slate so totals are deterministic regardless of test ordering on the shared container.
        // Child tables first: events.created_by (and event_attendance.user_id) FK-reference users,
        // so users can only be wiped after their dependents (TM-391 added the events schema).
        // The chat tables (TM-435) also FK-reference users — message.sender_id has no ON DELETE
        // action (same convention as events.created_by), so a leftover message would block the user
        // wipe; clear the chat dependents (message → conversation_member → conversation) first too.
        jdbc.update("DELETE FROM message");
        jdbc.update("DELETE FROM conversation_member");
        jdbc.update("DELETE FROM conversation");
        jdbc.update("DELETE FROM event_attendance");
        jdbc.update("DELETE FROM events");
        jdbc.update("DELETE FROM users");
        // Five active accounts: ada, bea, cyd, dan, eve.
        users.save(new User("uid-ada", "ada@example.com", "Ada"));
        users.save(new User("uid-bea", "bea@example.com", "Bea"));
        users.save(new User("uid-cyd", "cyd@example.com", "Cyd"));
        users.save(new User("uid-dan", "dan@example.com", "Dan"));
        users.save(new User("uid-eve", "eve@example.com", "Eve"));
        // Entity exposes no role/enabled mutators (those land with admin actions, TM-111); set via SQL.
        jdbc.update("UPDATE users SET role = 'ADMIN' WHERE firebase_uid = 'uid-ada'");
        jdbc.update("UPDATE users SET enabled = false WHERE firebase_uid = 'uid-bea'");
        // A soft-deleted account must be excluded from the list entirely.
        userService.softDelete("uid-eve");
    }

    @Test
    void pagesAndExcludesSoftDeleted() {
        PageResponse<UserSummary> firstPage = userService.list(null, null, null, 0, 2, "email,asc");

        assertThat(firstPage.totalElements()).isEqualTo(4); // eve is soft-deleted → hidden
        assertThat(firstPage.totalPages()).isEqualTo(2); // ceil(4 / 2)
        assertThat(firstPage.size()).isEqualTo(2);
        assertThat(firstPage.items()).extracting(UserSummary::email).containsExactly("ada@example.com", "bea@example.com");

        PageResponse<UserSummary> secondPage = userService.list(null, null, null, 1, 2, "email,asc");
        assertThat(secondPage.items()).extracting(UserSummary::email).containsExactly("cyd@example.com", "dan@example.com");
    }

    @Test
    void sortDescendingIsHonoured() {
        PageResponse<UserSummary> page = userService.list(null, null, null, 0, 10, "email,desc");
        assertThat(page.items())
                .extracting(UserSummary::email)
                .containsExactly("dan@example.com", "cyd@example.com", "bea@example.com", "ada@example.com");
    }

    @Test
    void oversizedSizeIsClampedToMax() {
        PageResponse<UserSummary> page = userService.list(null, null, null, 0, 9999, null);
        assertThat(page.size()).isEqualTo(PageRequests.MAX_SIZE);
    }

    @Test
    void filtersBySearchTermAcrossEmailAndDisplayName() {
        assertThat(userService.list("ada", null, null, 0, 10, null).items())
                .extracting(UserSummary::displayName)
                .containsExactly("Ada");
    }

    @Test
    void filtersByRoleAndStatus() {
        PageResponse<UserSummary> admins = userService.list(null, Role.ADMIN, null, 0, 10, null);
        assertThat(admins.items()).extracting(UserSummary::email).containsExactly("ada@example.com");

        PageResponse<UserSummary> disabled = userService.list(null, null, false, 0, 10, null);
        assertThat(disabled.items()).extracting(UserSummary::email).containsExactly("bea@example.com");
    }
}
