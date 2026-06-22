package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.teammarhaba.backend.auth.RoleService;
import com.teammarhaba.backend.web.ResourceNotFoundException;
import com.teammarhaba.backend.web.SelfActionNotAllowedException;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;

/** Rules of admin user-management (TM-111): 404 semantics, self-protection, claim-first role change. */
class UserAdminServiceTest {

    private final UserRepository users = mock(UserRepository.class);
    private final RoleService roleService = mock(RoleService.class);
    private final UserAdminService service = new UserAdminService(users, roleService);

    private static User account(String uid) {
        return new User(uid, uid + "@example.com", null);
    }

    @Test
    void getMissingIdIs404() {
        when(users.findById(9L)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.get(9L)).isInstanceOf(ResourceNotFoundException.class);
    }

    @Test
    void disableOfAnotherUserPersistsAndTouchesNoClaim() throws Exception {
        User target = account("target");
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, false, null, "admin-uid");

        assertThat(target.isEnabled()).isFalse();
        verifyNoInteractions(roleService);
    }

    @Test
    void roleChangeWritesClaimThenMirrorsRow() throws Exception {
        User target = account("target"); // USER by default
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, null, Role.ADMIN, "admin-uid");

        verify(roleService).assignRole("target", Role.ADMIN);
        assertThat(target.getRole()).isEqualTo(Role.ADMIN);
    }

    @Test
    void roleChangeToSameRoleIsANoOp() throws Exception {
        User target = account("target"); // already USER
        when(users.findById(1L)).thenReturn(Optional.of(target));

        service.update(1L, null, Role.USER, "admin-uid");

        verifyNoInteractions(roleService);
    }

    @Test
    void cannotDisableOwnAccount() {
        User self = account("self");
        when(users.findById(1L)).thenReturn(Optional.of(self));

        assertThatThrownBy(() -> service.update(1L, false, null, "self"))
                .isInstanceOf(SelfActionNotAllowedException.class);
        assertThat(self.isEnabled()).isTrue();
        verifyNoInteractions(roleService);
    }

    @Test
    void cannotChangeOwnRole() {
        User self = account("self"); // USER
        when(users.findById(1L)).thenReturn(Optional.of(self));

        assertThatThrownBy(() -> service.update(1L, null, Role.ADMIN, "self"))
                .isInstanceOf(SelfActionNotAllowedException.class);
        assertThat(self.getRole()).isEqualTo(Role.USER);
        verifyNoInteractions(roleService);
    }

    @Test
    void canReEnableYourOwnAccount() throws Exception {
        // Self-protection blocks disabling/demoting yourself, not enabling — that can't lock you out.
        User self = account("self");
        when(users.findById(1L)).thenReturn(Optional.of(self));

        service.update(1L, true, null, "self");

        assertThat(self.isEnabled()).isTrue();
    }

    @Test
    void listDelegatesToRepository() {
        Pageable pageable = PageRequest.of(0, 20);
        Page<User> page = new PageImpl<>(List.of(account("a")));
        when(users.findAll(pageable)).thenReturn(page);

        assertThat(service.list(pageable)).isSameAs(page);
    }
}
