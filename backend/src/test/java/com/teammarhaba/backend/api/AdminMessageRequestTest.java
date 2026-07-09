package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.messaging.AudienceSpec;
import com.teammarhaba.backend.messaging.TargetType;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Pure Bean-Validation unit tests for {@link AdminMessageRequest} (TM-441) — the "one target type per
 * send" cross-field rule, the length/size caps, and the derivation helpers ({@code targetType} /
 * {@code toAudienceSpec} / {@code targetRef}) the controller relies on. No Spring context: a standalone
 * {@link Validator} exercises the annotations exactly as the {@code @Valid} binding would.
 */
class AdminMessageRequestTest {

    private static ValidatorFactory factory;
    private static Validator validator;

    @BeforeAll
    static void setUp() {
        factory = Validation.buildDefaultValidatorFactory();
        validator = factory.getValidator();
    }

    @AfterAll
    static void tearDown() {
        factory.close();
    }

    private static Set<String> violationProperties(AdminMessageRequest request) {
        return validator.validate(request).stream()
                .map(ConstraintViolation::getPropertyPath)
                .map(Object::toString)
                .collect(Collectors.toSet());
    }

    // --- exactly-one-target-type -----------------------------------------------------------------

    @Test
    void singleUserTargetIsValidAndDerivesUserSpec() {
        AdminMessageRequest request =
                new AdminMessageRequest("Hi", "There", null, List.of(1L, 2L), null, null);

        assertThat(violationProperties(request)).isEmpty();
        assertThat(request.isExactlyOneTargetType()).isTrue();
        assertThat(request.targetType()).isEqualTo(TargetType.USER);
        assertThat(request.toAudienceSpec()).isEqualTo(AudienceSpec.users(List.of(1L, 2L)));
        assertThat(request.targetRef()).isEqualTo("1,2");
    }

    @Test
    void singleCityTargetIsValidAndDerivesCitySpec() {
        AdminMessageRequest request =
                new AdminMessageRequest("Hi", "There", null, null, List.of("London"), null);

        assertThat(violationProperties(request)).isEmpty();
        assertThat(request.targetType()).isEqualTo(TargetType.CITY);
        assertThat(request.toAudienceSpec()).isEqualTo(AudienceSpec.cities(List.of("London")));
        assertThat(request.targetRef()).isEqualTo("London");
    }

    @Test
    void singleEventTargetIsValidAndDerivesEventSpec() {
        AdminMessageRequest request =
                new AdminMessageRequest("Hi", "There", null, null, null, List.of(7L));

        assertThat(violationProperties(request)).isEmpty();
        assertThat(request.targetType()).isEqualTo(TargetType.EVENT);
        assertThat(request.toAudienceSpec()).isEqualTo(AudienceSpec.events(List.of(7L)));
        assertThat(request.targetRef()).isEqualTo("7");
    }

    @Test
    void noTargetTypeIsRejected() {
        AdminMessageRequest request = new AdminMessageRequest("Hi", "There", null, null, null, null);

        assertThat(request.isExactlyOneTargetType()).isFalse();
        assertThat(violationProperties(request)).contains("exactlyOneTargetType");
    }

    @Test
    void combiningTwoTargetTypesIsRejected() {
        AdminMessageRequest request =
                new AdminMessageRequest("Hi", "There", null, List.of(1L), List.of("London"), null);

        assertThat(request.isExactlyOneTargetType()).isFalse();
        assertThat(violationProperties(request)).contains("exactlyOneTargetType");
    }

    // --- length / size caps ----------------------------------------------------------------------

    @Test
    void blankTitleIsRejected() {
        AdminMessageRequest request =
                new AdminMessageRequest("  ", "There", null, List.of(1L), null, null);
        assertThat(violationProperties(request)).contains("title");
    }

    @Test
    void blankBodyIsRejected() {
        AdminMessageRequest request = new AdminMessageRequest("Hi", "", null, List.of(1L), null, null);
        assertThat(violationProperties(request)).contains("body");
    }

    @Test
    void overCapTitleIsRejected() {
        String title = "x".repeat(AdminMessageRequest.MAX_TITLE_LENGTH + 1);
        AdminMessageRequest request =
                new AdminMessageRequest(title, "There", null, List.of(1L), null, null);
        assertThat(violationProperties(request)).contains("title");
    }

    @Test
    void bodyAtTheCapIsAcceptedButOverCapIsRejected() {
        String atCap = "x".repeat(AdminMessageRequest.MAX_BODY_LENGTH);
        assertThat(violationProperties(new AdminMessageRequest("Hi", atCap, null, List.of(1L), null, null)))
                .isEmpty();

        String overCap = "x".repeat(AdminMessageRequest.MAX_BODY_LENGTH + 1);
        assertThat(violationProperties(new AdminMessageRequest("Hi", overCap, null, List.of(1L), null, null)))
                .contains("body");
    }

    @Test
    void overCapUserIdsIsRejected() {
        List<Long> tooMany = java.util.stream.LongStream.rangeClosed(1, AdminMessageRequest.MAX_USER_IDS + 1)
                .boxed()
                .toList();
        AdminMessageRequest request = new AdminMessageRequest("Hi", "There", null, tooMany, null, null);
        assertThat(violationProperties(request)).contains("userIds");
    }

    // --- target_ref truncation -------------------------------------------------------------------

    @Test
    void targetRefIsTruncatedToTheColumnWidth() {
        // A long-but-in-cap explicit id list can exceed the target_ref column; targetRef truncates it
        // (the exact membership is recoverable from the per-recipient notifications, not this descriptor).
        List<Long> manyIds = java.util.stream.LongStream.rangeClosed(1_000_000_000L, 1_000_000_299L)
                .boxed()
                .toList();
        AdminMessageRequest request = new AdminMessageRequest("Hi", "There", null, manyIds, null, null);

        assertThat(violationProperties(request)).isEmpty(); // 300 ids is under the 500 cap
        assertThat(request.targetRef()).hasSize(1024).endsWith("…");
    }
}
