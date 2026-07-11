package com.teammarhaba.backend.chat;

import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The pure @mention parser (TM-469, epic Event Chat wave-4) — the backend twin of the web SPA's
 * {@code chat-mentions-core.js}. Given a posted message body and the thread's mentionable roster
 * (its active members, name + id), it resolves the three mention forms the composer offers:
 *
 * <ul>
 *   <li><b>an individual</b> — {@code @DisplayName} that matches a roster member's display name;
 *   <li><b>{@code @everyone}</b> — the reserved keyword for "every member of this thread"; and
 *   <li><b>{@code @here}</b> — the reserved keyword for "every member currently online" (resolved to
 *       actual online ids by the caller from the live-transport presence, TM-464 — this parser only
 *       reports that {@code @here} was <em>used</em>).
 * </ul>
 *
 * <p><b>Why parse from the body (no stored mention refs).</b> A mention is fully recoverable from the
 * message text plus the roster, so this ticket deliberately stores no mention table (main is at V39):
 * the post path re-parses the committed body to fan the notification out, and the renderer re-parses
 * it to highlight the chips. Keeping the one algorithm here (and mirrored byte-for-byte in the JS core)
 * means the server's "who to notify" and the client's "what to highlight" can never disagree.
 *
 * <p><b>Resolution rules (the AC).</b>
 * <ul>
 *   <li>An individual token resolves <em>only</em> to a member of the roster — a {@code @Name} that
 *       matches nobody in the thread is left as plain text and notifies no-one ("non-members ignored").
 *   <li>Matching is <b>case-insensitive</b> and <b>longest-name-first</b>, so with both "Ali" and
 *       "Ali Hassan" in the thread, {@code @Ali Hassan} resolves to the two-word member, while
 *       {@code @Ali here} resolves to "Ali". A name only matches at a <em>word boundary</em> (the next
 *       char is the end, whitespace or punctuation — never another letter/digit), so {@code @Anna}
 *       never resolves a member merely called "Ann".
 *   <li>An {@code @} only triggers when it starts a token — at the start of the body or after
 *       whitespace/punctuation — so an email address ({@code a@b.com}) or a mid-word {@code @} never
 *       parses as a mention.
 *   <li>{@code @everyone} / {@code @here} are <b>reserved keywords</b> checked before member names, so
 *       they always win over a member who happens to be named "everyone"/"here".
 * </ul>
 *
 * <p>Stateless and dependency-free — a plain static utility, unit-tested in isolation
 * ({@code MentionResolverTest}); the notifier ({@link MentionNotifier}) feeds it the roster and turns
 * its {@link Resolution} into the actual notified user set.
 */
public final class MentionResolver {

    private MentionResolver() {
        // Static utility — never instantiated.
    }

    /** The reserved "everyone in this thread" keyword, matched case-insensitively after an {@code @}. */
    public static final String EVERYONE = "everyone";

    /** The reserved "everyone currently online" keyword, matched case-insensitively after an {@code @}. */
    public static final String HERE = "here";

    /**
     * One mentionable member of a thread — the roster entry the parser matches an individual
     * {@code @Name} against. {@code displayName} is the member's profile name as the composer inserts
     * it; a blank name is un-mentionable (it can never be typed as a distinguishing token) and is
     * skipped.
     */
    public record Member(long userId, String displayName) {}

    /**
     * The outcome of parsing a body against a roster: whether {@code @everyone} / {@code @here} were
     * used, and the set of individually-mentioned member ids (insertion-ordered, de-duplicated — a name
     * typed twice notifies once). The caller expands {@code everyone} / {@code here} to real ids and
     * unions them with {@link #userIds()}.
     *
     * @param everyone {@code @everyone} was used — fan out to every member
     * @param here     {@code @here} was used — fan out to every online member
     * @param userIds  the individually-mentioned member ids (a subset of the roster), de-duplicated
     */
    public record Resolution(boolean everyone, boolean here, Set<Long> userIds) {

        /** {@code true} when nothing at all was mentioned — no keyword and no individual. */
        public boolean isEmpty() {
            return !everyone && !here && userIds.isEmpty();
        }
    }

    private static final Resolution NONE = new Resolution(false, false, Set.of());

    /**
     * Parse {@code body} against {@code roster}, returning which keywords fired and which members were
     * individually mentioned. A {@code null}/blank body or empty roster still parses (keywords need no
     * roster); an individual match needs a non-blank roster name.
     */
    public static Resolution resolve(String body, List<Member> roster) {
        if (body == null || body.isBlank()) {
            return NONE;
        }
        // Longest display name first so "Ali Hassan" wins over "Ali" when both could start here. Blank
        // names are dropped up front — they can't be typed as a token and would match a bare "@".
        List<Member> byLongestName = roster.stream()
                .filter(m -> m.displayName() != null && !m.displayName().isBlank())
                .sorted(Comparator.comparingInt((Member m) -> m.displayName().length()).reversed())
                .toList();

        boolean everyone = false;
        boolean here = false;
        Set<Long> userIds = new LinkedHashSet<>();

        int i = 0;
        int n = body.length();
        while (i < n) {
            if (body.charAt(i) != '@' || !startsToken(body, i)) {
                i++;
                continue;
            }
            int after = i + 1; // first char past the '@'
            if (matchesKeyword(body, after, EVERYONE)) {
                everyone = true;
                i = after + EVERYONE.length();
                continue;
            }
            if (matchesKeyword(body, after, HERE)) {
                here = true;
                i = after + HERE.length();
                continue;
            }
            Member hit = matchMember(body, after, byLongestName);
            if (hit != null) {
                userIds.add(hit.userId());
                i = after + hit.displayName().length();
                continue;
            }
            i++; // a bare '@' or an unknown name — leave it as plain text
        }
        return new Resolution(everyone, here, userIds);
    }

    /**
     * An {@code @} at {@code index} only begins a mention token when it is at the start of the body or
     * follows a non-"word" character (whitespace or punctuation). This is what stops an email address
     * ({@code alice@example.com}) or a mid-word {@code @} from parsing as a mention.
     */
    private static boolean startsToken(String body, int index) {
        return index == 0 || !isNameChar(body.charAt(index - 1));
    }

    /**
     * Whether the text from {@code start} begins with the reserved {@code keyword} (case-insensitive)
     * at a word boundary — the char after the keyword must be the end, whitespace or punctuation, never
     * another letter/digit, so {@code @hereabouts} is NOT {@code @here}.
     */
    private static boolean matchesKeyword(String body, int start, String keyword) {
        return regionMatchesBoundary(body, start, keyword);
    }

    /**
     * The first roster member whose display name the text from {@code start} begins with (case-
     * insensitive, at a word boundary), scanning {@code byLongestName} so the longest name wins; or
     * {@code null} if none match.
     */
    private static Member matchMember(String body, int start, List<Member> byLongestName) {
        for (Member member : byLongestName) {
            if (regionMatchesBoundary(body, start, member.displayName())) {
                return member;
            }
        }
        return null;
    }

    /**
     * Whether {@code body} at {@code start} equals {@code token} (case-insensitive) AND ends on a word
     * boundary — the shared core of both keyword and member matching. An empty token never matches.
     */
    private static boolean regionMatchesBoundary(String body, int start, String token) {
        int len = token.length();
        if (len == 0 || start + len > body.length()) {
            return false;
        }
        if (!body.regionMatches(true, start, token, 0, len)) {
            return false;
        }
        int end = start + len;
        return end == body.length() || !isNameChar(body.charAt(end));
    }

    /**
     * A "name/word" character for boundary detection: a letter or digit. Whitespace and punctuation are
     * boundaries, so a mention can be followed by {@code ,}/{@code !}/{@code )}/space/end without
     * swallowing them, and a member name is never matched inside a longer word.
     */
    private static boolean isNameChar(char c) {
        return Character.isLetterOrDigit(c);
    }
}
