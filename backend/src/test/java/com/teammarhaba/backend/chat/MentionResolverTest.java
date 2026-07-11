package com.teammarhaba.backend.chat;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.chat.MentionResolver.Member;
import com.teammarhaba.backend.chat.MentionResolver.Resolution;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Unit tests for the pure @mention parser (TM-469) — the "individual resolve, @everyone/@here
 * expansion, non-member ignored" acceptance criteria at the algorithm level, with no Spring/DB. This is
 * the server twin of the web {@code chat-mentions-core.test.mjs}; both must agree on what a body means.
 */
class MentionResolverTest {

    private static final Member ALICE = new Member(1L, "Alice");
    private static final Member BOB = new Member(2L, "Bob");
    private static final Member ALI_HASSAN = new Member(3L, "Ali Hassan");
    private static final List<Member> ROSTER = List.of(ALICE, BOB, ALI_HASSAN);

    @Test
    void resolvesAnIndividualToTheirMemberId() {
        Resolution r = MentionResolver.resolve("hey @Alice can you make it?", ROSTER);
        assertThat(r.userIds()).containsExactly(1L);
        assertThat(r.everyone()).isFalse();
        assertThat(r.here()).isFalse();
    }

    @Test
    void matchIsCaseInsensitive() {
        assertThat(MentionResolver.resolve("@alice hi", ROSTER).userIds()).containsExactly(1L);
        assertThat(MentionResolver.resolve("@BOB hi", ROSTER).userIds()).containsExactly(2L);
    }

    @Test
    void everyoneKeywordFires() {
        Resolution r = MentionResolver.resolve("listen up @everyone!", ROSTER);
        assertThat(r.everyone()).isTrue();
        assertThat(r.here()).isFalse();
        assertThat(r.userIds()).isEmpty();
    }

    @Test
    void hereKeywordFires() {
        Resolution r = MentionResolver.resolve("who's around @here?", ROSTER);
        assertThat(r.here()).isTrue();
        assertThat(r.everyone()).isFalse();
        assertThat(r.userIds()).isEmpty();
    }

    @Test
    void nonMemberNameIsIgnored() {
        // "Dave" is not in the roster — no id resolves, nothing is mentioned.
        Resolution r = MentionResolver.resolve("hi @Dave and @Zoe", ROSTER);
        assertThat(r.isEmpty()).isTrue();
    }

    @Test
    void longestNameWinsWhenTwoNamesShareAPrefix() {
        // "@Ali Hassan" must resolve the two-word member (id 3), not the shorter "Ali"-prefixed one.
        // (No bare "Ali" member exists here, but "Ali Hassan" starts with the letters of a would-be "Ali".)
        Resolution r = MentionResolver.resolve("thanks @Ali Hassan", ROSTER);
        assertThat(r.userIds()).containsExactly(3L);
    }

    @Test
    void aNameIsOnlyMatchedAtAWordBoundary() {
        // "@Alicia" must NOT resolve member "Alice" — the char after "Alice" would be 'i' (a letter),
        // so the boundary check rejects the partial match and it stays plain text.
        Resolution r = MentionResolver.resolve("@Alicia is new", ROSTER);
        assertThat(r.isEmpty()).isTrue();
    }

    @Test
    void punctuationAfterANameStillResolves() {
        // Trailing punctuation is a boundary, so "@Alice," / "@Bob!" resolve without swallowing the mark.
        assertThat(MentionResolver.resolve("cc @Alice, @Bob!", ROSTER).userIds()).containsExactly(1L, 2L);
    }

    @Test
    void midWordAtSignIsNotAMention() {
        // An email address (or any '@' preceded by a letter/digit) never triggers a mention.
        Resolution r = MentionResolver.resolve("mail me at alice@example.com", ROSTER);
        assertThat(r.isEmpty()).isTrue();
    }

    @Test
    void aNameTypedTwiceNotifiesOnce() {
        Resolution r = MentionResolver.resolve("@Alice @Alice are you there", ROSTER);
        assertThat(r.userIds()).containsExactly(1L);
    }

    @Test
    void keywordsAndIndividualsCombine() {
        Resolution r = MentionResolver.resolve("@everyone especially @Bob", ROSTER);
        assertThat(r.everyone()).isTrue();
        assertThat(r.userIds()).containsExactly(2L);
    }

    @Test
    void nullOrBlankBodyResolvesToNothing() {
        assertThat(MentionResolver.resolve(null, ROSTER).isEmpty()).isTrue();
        assertThat(MentionResolver.resolve("   ", ROSTER).isEmpty()).isTrue();
        assertThat(MentionResolver.resolve("no mentions here", ROSTER).isEmpty()).isTrue();
    }

    @Test
    void blankRosterNamesAreNeverMatched() {
        // A member with a blank display name can't be typed as a token and must not match a bare "@".
        List<Member> withBlank = List.of(new Member(9L, "  "), ALICE);
        Resolution r = MentionResolver.resolve("@ @Alice", withBlank);
        assertThat(r.userIds()).containsExactly(1L);
    }
}
