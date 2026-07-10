package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.chat.TypingSignalService;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The <b>typing indicator</b> signal endpoint (TM-465, epic Event Chat) — the client→server half of
 * "X is typing…". SSE (TM-464) is one-way, so the client can't push typing up the stream; instead it
 * POSTs this lightweight, <b>debounced</b> signal (at most once every few seconds while composing, never
 * per-keystroke) and the server fans a transient {@code typing} event back down the thread's existing SSE
 * streams to its OTHER connected members. The {@code /api/v1} prefix is applied by {@link ApiV1Config};
 * the gate + fan-out live in {@link TypingSignalService}.
 *
 * <p><b>Ephemeral by design.</b> Nothing is persisted — no row, no migration. A signal that reaches
 * nobody (offline members, or a post that landed on a different Cloud Run instance than a subscriber) is
 * simply not seen; for a transient hint that is lossless, so the endpoint returns {@code 202 Accepted}
 * with no body ("signal accepted for best-effort fan-out"), not a resource.
 *
 * <p><b>Auth + members-only (an AC).</b> Like every {@code /api/v1} route this requires a verified
 * Firebase bearer token (an anonymous/expired token is the uniform {@code 401}); and the caller must be a
 * member of the thread, so a non-member, a kicked member, a self-left member and an unknown/foreign
 * thread are all a uniform {@code 403} — a typing POST can't be used to probe which thread ids exist.
 */
@RestController
public class ConversationTypingController {

    private final TypingSignalService typing;

    ConversationTypingController(TypingSignalService typing) {
        this.typing = typing;
    }

    /**
     * Signal that the caller is (or, with {@code {"typing": false}}, has stopped) typing in thread
     * {@code id}, fanning the transient {@code typing} event out over SSE to the thread's other connected
     * members. The body is optional — a body-less POST is the common "I'm typing" heartbeat
     * ({@code typing} defaults to {@code true}); {@code {"typing": false}} stops the indicator early.
     * Members-only ({@code 403} otherwise), auth required ({@code 401} otherwise). Returns {@code 202}
     * with no body — the signal is ephemeral, so there is nothing to return.
     *
     * @param caller the verified principal (never client-supplied) — the typist
     * @param id     the conversation being typed in
     * @param body   the optional typing state ({@code null} = the "I'm typing" heartbeat)
     */
    @PostMapping("/conversations/{id}/typing")
    @ResponseStatus(HttpStatus.ACCEPTED)
    void typing(
            @AuthenticationPrincipal VerifiedUser caller,
            @PathVariable Long id,
            @RequestBody(required = false) TypingRequest body) {
        typing.signal(caller, id, body == null ? true : body.typingOrDefault());
    }
}
