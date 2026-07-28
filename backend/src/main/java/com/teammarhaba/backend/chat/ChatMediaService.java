package com.teammarhaba.backend.chat;

import com.google.cloud.storage.BlobInfo;
import com.google.cloud.storage.HttpMethod;
import com.google.cloud.storage.Storage;
import com.google.cloud.storage.Storage.SignUrlOption;
import com.teammarhaba.backend.api.ChatMediaSignedUrlResponse;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.config.AppProperties;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserService;
import java.net.URL;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;

/**
 * The chat-media signed-URL mint (TM-1126, epic TM-468 chat-media foundation) — the backend seam that
 * lets a thread member upload a photo/file to, and read it back from, a <strong>PRIVATE</strong>
 * Cloud Storage prefix, without ever exposing a service-account key or making the object public.
 *
 * <p><b>Why signed URLs (the private posture).</b> Unlike avatars / event-images (world-readable, so
 * they can be fetched by an unguessable download URL — see {@code storage.rules}), chat media is
 * conversation-private: only the thread's members may see it. The Storage rules therefore deny the
 * {@code chat-media/**} prefix by default, and every read/write is brokered here as a short-lived,
 * V4-signed URL — the caller PUTs bytes to the upload URL and later GETs them via the download URL,
 * both of which expire. A leaked URL grants only brief access to one object, and a non-member never
 * gets one at all.
 *
 * <p><b>The member gate (per the AC).</b> Exactly the {@code MessagePostService} post gate: the caller
 * must be an <em>active</em> ({@link MuteState#NONE}) member of the thread. A non-member, a
 * {@link MuteState#REMOVED} (kicked), {@link MuteState#READ_ONLY} (muted) or {@link MuteState#LEFT}
 * (self-left) membership — <em>and an unknown / foreign thread</em> (no membership row) — are all a
 * uniform {@code 403} ({@link AccessDeniedException}, mapped to RFC-7807 {@code problem+json} by the
 * global handler), so a caller can't probe which thread ids exist and can't upload media into a thread
 * they can't post to. Identity is always the verified caller (just-in-time provisioned), never a
 * client-supplied id.
 *
 * <p><b>The object path is conversation-scoped and backend-chosen.</b> Every object lands at
 * {@code chat-media/{conversationId}/{uuid}} — the {@code conversationId} is the gated thread and the
 * {@code uuid} is a fresh random name, both picked here, so the client cannot steer an upload into
 * another conversation's prefix or overwrite an existing object.
 */
@Service
public class ChatMediaService {

    /** Object-path prefix for all chat media — a PRIVATE prefix denied by default in {@code storage.rules}. */
    static final String CHAT_MEDIA_PREFIX = "chat-media";

    /**
     * How long a minted upload/download URL stays valid. Short-lived by design (the private posture):
     * long enough for a client to complete an upload then immediately render the download, short enough
     * that a leaked URL is useless minutes later. The client re-requests once it elapses.
     */
    static final Duration URL_TTL = Duration.ofMinutes(15);

    private final UserService users;
    private final ConversationMemberRepository members;
    private final ObjectProvider<Storage> storage;
    private final AppProperties props;

    public ChatMediaService(
            UserService users,
            ConversationMemberRepository members,
            ObjectProvider<Storage> storage,
            AppProperties props) {
        this.users = users;
        this.members = members;
        // ObjectProvider (lazy) so the Storage bean — and therefore Firebase Admin init — is only
        // resolved when this endpoint actually runs. Dev/test/CI, which never call it, stay
        // credential-free and don't need Storage configured to boot.
        this.storage = storage;
        this.props = props;
    }

    /**
     * Mint a signed upload URL and resolve a signed download URL for a fresh chat-media object in thread
     * {@code conversationId}, for the verified caller. Applies the active-member gate first, then chooses
     * the conversation-scoped object path {@code chat-media/{conversationId}/{uuid}} and signs both URLs
     * against it.
     *
     * @throws AccessDeniedException {@code 403} if the caller is not an active member of the thread —
     *     including an unknown / foreign thread (no membership row), so existence isn't leaked
     * @throws IllegalStateException {@code 500} if the Storage bucket is not configured for this
     *     deployment (dev/test builds with no {@code app.firebase.storage-bucket}); the rest of the app
     *     still boots, only this feature refuses
     */
    public ChatMediaSignedUrlResponse mintSignedUrls(VerifiedUser caller, Long conversationId) {
        User author = users.provision(caller);
        requireActiveMember(conversationId, author.getId());

        // Conversation-scoped, backend-chosen path: the gated conversation id + a fresh random name, so
        // the client can neither target another thread's prefix nor overwrite an existing object.
        String objectPath = CHAT_MEDIA_PREFIX + "/" + conversationId + "/" + UUID.randomUUID();

        Storage gcs = requireStorage();
        BlobInfo blob = BlobInfo.newBuilder(requireBucket(), objectPath).build();

        // A V4-signed PUT the client uploads the bytes with, and a V4-signed GET it reads them back with.
        // Both are scoped to exactly this one object and expire after URL_TTL.
        URL uploadUrl = gcs.signUrl(
                blob,
                URL_TTL.toSeconds(),
                TimeUnit.SECONDS,
                SignUrlOption.httpMethod(HttpMethod.PUT),
                SignUrlOption.withV4Signature());
        URL downloadUrl = gcs.signUrl(
                blob,
                URL_TTL.toSeconds(),
                TimeUnit.SECONDS,
                SignUrlOption.httpMethod(HttpMethod.GET),
                SignUrlOption.withV4Signature());

        return new ChatMediaSignedUrlResponse(
                objectPath, uploadUrl.toString(), downloadUrl.toString(), URL_TTL.toSeconds());
    }

    /**
     * The AC's member gate — identical to {@link MessagePostService}'s post gate: the caller must be a
     * member of the thread whose mute state is {@link MuteState#NONE} (an active member). A non-member,
     * a {@code REMOVED}/{@code READ_ONLY}/{@code LEFT} member, and an unknown / foreign thread (no row)
     * are all a uniform {@code 403}, so thread ids can't be probed and only someone who can post may mint
     * a media URL.
     */
    private void requireActiveMember(Long conversationId, Long userId) {
        MuteState mute = members.findByConversationIdAndUserId(conversationId, userId)
                .map(ConversationMember::getMute)
                .orElseThrow(() -> new AccessDeniedException("You are not a member of this thread."));
        if (mute != MuteState.NONE) {
            // READ_ONLY / LEFT / REMOVED all collapse to the same "not a member" 403 — a caller who
            // cannot post also cannot upload media, and the copy never distinguishes the reason.
            throw new AccessDeniedException("You are not a member of this thread.");
        }
    }

    /** The Storage client, or a clear {@code 500} when Storage isn't wired for this deployment. */
    private Storage requireStorage() {
        Storage gcs = storage.getIfAvailable();
        if (gcs == null) {
            throw new IllegalStateException("Chat media is unavailable: Firebase Storage is not configured.");
        }
        return gcs;
    }

    /** The configured bucket, or a clear {@code 500} when it isn't set (dev/test builds). */
    private String requireBucket() {
        String bucket = props.firebase().storageBucket();
        if (bucket == null || bucket.isBlank()) {
            throw new IllegalStateException("Chat media is unavailable: no storage bucket is configured.");
        }
        return bucket;
    }
}
