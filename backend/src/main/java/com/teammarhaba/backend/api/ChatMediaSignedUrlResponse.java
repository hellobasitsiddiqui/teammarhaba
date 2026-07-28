package com.teammarhaba.backend.api;

/**
 * The signed-URL pair the chat-media upload handshake returns (TM-1126, epic TM-468 chat-media
 * foundation) — issued by {@code POST /api/v1/conversations/{id}/media/signed-url} to a member of the
 * thread.
 *
 * <p><b>PRIVATE posture.</b> Chat media lives under {@code chat-media/{conversationId}/{uuid}}, a
 * prefix the Storage rules deny by default (unlike the world-readable avatars / event-images), so it is
 * never publicly readable. Every read and write goes through a short-lived, backend-minted signed URL:
 * the caller PUTs the bytes to {@code uploadUrl}, and later fetches them via {@code downloadUrl}. Both
 * expire, so a leaked URL grants only brief access and only to that one object.
 *
 * <p><b>Conversation-scoped path.</b> {@code objectPath} is always {@code chat-media/{conversationId}/…}
 * for the thread the caller is a member of — the backend, not the client, chooses it, so a caller can't
 * steer an upload into another conversation's prefix.
 *
 * @param objectPath  the object's key in the bucket, {@code chat-media/{conversationId}/{uuid}} — the
 *                    stable reference the client persists on the (future) media message row
 * @param uploadUrl   a short-lived signed {@code PUT} URL the client uploads the media bytes to
 * @param downloadUrl a short-lived signed {@code GET} URL the client reads the uploaded media back from
 * @param expiresInSeconds how long (seconds) both URLs remain valid from issue — the client re-requests
 *                    once elapsed rather than caching a stale URL
 */
public record ChatMediaSignedUrlResponse(
        String objectPath, String uploadUrl, String downloadUrl, long expiresInSeconds) {}
