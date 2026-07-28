package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.google.cloud.storage.BlobInfo;
import com.google.cloud.storage.Storage;
import com.google.cloud.storage.Storage.SignUrlOption;
import com.teammarhaba.backend.api.ChatMediaSignedUrlResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.AppProperties;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.net.URI;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.access.AccessDeniedException;

/**
 * The chat-media signed-URL mint (TM-1126) — its member gate, conversation-scoped path, and PRIVATE
 * signed-URL posture, pinned against a MOCKED Storage client (no real GCS is ever touched). Asserts:
 *
 * <ul>
 *   <li>an active ({@code NONE}) member gets a signed upload + download URL, both scoped to a
 *       {@code chat-media/{conversationId}/{uuid}} object path;</li>
 *   <li>a non-member, and every non-active membership state ({@code READ_ONLY} / {@code LEFT} /
 *       {@code REMOVED}), is a uniform {@code 403} ({@link AccessDeniedException}) and NEVER signs a
 *       URL — so a non-member can't mint one and can't probe thread ids;</li>
 *   <li>the object path is conversation-scoped: the signed blob's name is always under this thread's
 *       {@code chat-media/{id}/} prefix.</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
class ChatMediaServiceTest {

    private static final long CONV_ID = 77L;
    private static final long USER_ID = 3L;
    private static final String BUCKET = "teammarhaba-test.appspot.com";
    private static final VerifiedUser CALLER = new VerifiedUser("caller-uid", "caller@example.com");

    @Mock private UserService users;
    @Mock private ConversationMemberRepository members;
    @Mock private Storage storage;
    @Mock private ObjectProvider<Storage> storageProvider;

    private ChatMediaService service() {
        AppProperties props = new AppProperties(
                new AppProperties.Db("db", "user", "pw", "inst"),
                new AppProperties.Firebase("teammarhaba-test", BUCKET));
        return new ChatMediaService(users, members, storageProvider, props);
    }

    /** Stub {@link UserService#provision} to resolve the verified caller to {@link #USER_ID}. */
    private void provisioned() {
        User user = org.mockito.Mockito.mock(User.class);
        when(user.getId()).thenReturn(USER_ID);
        when(users.provision(CALLER)).thenReturn(user);
    }

    /** A membership row for the caller in {@code CONV_ID} with the given mute state. */
    private ConversationMember memberWith(MuteState mute) {
        ConversationMember member = new ConversationMember(CONV_ID, USER_ID, MemberRole.MEMBER);
        member.setMute(mute);
        return member;
    }

    @Test
    void activeMember_getsSignedUploadAndDownloadUrlsForConversationScopedPath() throws Exception {
        provisioned();
        when(members.findByConversationIdAndUserId(CONV_ID, USER_ID))
                .thenReturn(Optional.of(memberWith(MuteState.NONE)));
        when(storageProvider.getIfAvailable()).thenReturn(storage);
        when(storage.signUrl(any(BlobInfo.class), anyLong(), any(), any(SignUrlOption[].class)))
                .thenReturn(URI.create("https://signed.example/put").toURL())
                .thenReturn(URI.create("https://signed.example/get").toURL());

        ChatMediaSignedUrlResponse response = service().mintSignedUrls(CALLER, CONV_ID);

        // The path is conversation-scoped: chat-media/{conversationId}/{uuid}.
        assertThat(response.objectPath()).startsWith("chat-media/" + CONV_ID + "/");
        assertThat(response.objectPath()).matches("chat-media/" + CONV_ID + "/[0-9a-f-]{36}");
        assertThat(response.uploadUrl()).isEqualTo("https://signed.example/put");
        assertThat(response.downloadUrl()).isEqualTo("https://signed.example/get");
        assertThat(response.expiresInSeconds()).isPositive();

        // Both URLs are signed (twice) against the SAME conversation-scoped blob in the configured
        // bucket — one for upload, one for download — the private-posture handshake. (SignUrlOption has
        // no value equality, so the PUT/GET method choice is exercised via the two distinct returned
        // URLs above rather than by matching option instances here.)
        ArgumentCaptor<BlobInfo> blob = ArgumentCaptor.forClass(BlobInfo.class);
        verify(storage, org.mockito.Mockito.times(2))
                .signUrl(blob.capture(), anyLong(), any(), any(SignUrlOption[].class));
        assertThat(blob.getAllValues())
                .allSatisfy(b -> assertThat(b.getName()).startsWith("chat-media/" + CONV_ID + "/"));
        assertThat(blob.getAllValues()).allSatisfy(b -> assertThat(b.getBucket()).isEqualTo(BUCKET));
    }

    @Test
    void nonMember_isForbidden_andNeverSignsAUrl() {
        provisioned();
        when(members.findByConversationIdAndUserId(CONV_ID, USER_ID)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service().mintSignedUrls(CALLER, CONV_ID))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(storage);
    }

    @Test
    void readOnlyMember_isForbidden_andNeverSignsAUrl() {
        provisioned();
        when(members.findByConversationIdAndUserId(CONV_ID, USER_ID))
                .thenReturn(Optional.of(memberWith(MuteState.READ_ONLY)));

        assertThatThrownBy(() -> service().mintSignedUrls(CALLER, CONV_ID))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(storage);
    }

    @Test
    void leftMember_isForbidden_andNeverSignsAUrl() {
        provisioned();
        when(members.findByConversationIdAndUserId(CONV_ID, USER_ID))
                .thenReturn(Optional.of(memberWith(MuteState.LEFT)));

        assertThatThrownBy(() -> service().mintSignedUrls(CALLER, CONV_ID))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(storage);
    }

    @Test
    void removedMember_isForbidden_andNeverSignsAUrl() {
        provisioned();
        when(members.findByConversationIdAndUserId(CONV_ID, USER_ID))
                .thenReturn(Optional.of(memberWith(MuteState.REMOVED)));

        assertThatThrownBy(() -> service().mintSignedUrls(CALLER, CONV_ID))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(storage);
    }
}
