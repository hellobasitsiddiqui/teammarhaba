package com.teammarhaba.backend.api;

import com.teammarhaba.backend.interests.InterestCatalogueRepository;
import com.teammarhaba.backend.interests.InterestSelectionConfig;
import com.teammarhaba.backend.interests.UserInterestRepository;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public (any signed-in user) READ endpoints for the interests picker under {@code /api/v1/interests}
 * (TM-776, epic Interests). These back the onboarding interests PICK STEP (and the profile Interests
 * card): a fresh, half-onboarded USER needs to see the active catalogue and the min/max-selection
 * bounds, but the whole {@link InterestAdminController} is {@code ADMIN}-gated, so such a user would
 * get a {@code 403} there. This controller closes that gap with a lean read-only surface.
 *
 * <p><b>Authorization:</b> there is deliberately NO {@code @PreAuthorize} here — the endpoints inherit
 * the default-authenticated security chain ({@code SecurityConfig}: everything under {@code /api/v1}
 * that is not on the permit-list requires a verified Firebase token). So ANY signed-in user (USER or
 * ADMIN) gets a {@code 200}; an anonymous caller gets a uniform {@code 401} from the chain. They are
 * NOT permit-listed (unlike {@code /alerts/active}) because interests are only meaningful once you have
 * an account — there is no pre-login use.
 *
 * <ul>
 *   <li>{@code GET /interests/catalogue} — the CURRENTLY OFFERED interests (active + not tombstoned),
 *       ordered highlights/popular first (higher {@code sort_weight}) then alphabetically. Returns the
 *       lean {@link PublicInterestResponse} (label/category/highlighted/sortWeight) — the admin/internal
 *       fields (id, active, timestamps, soft-delete state, version) are intentionally not leaked. No
 *       paging: the seed catalogue is ~100 rows, so the full list is returned in one call.</li>
 *   <li>{@code GET /interests/config} — the min/max-selection bounds ({@code minSelections} /
 *       {@code maxSelections}), reusing {@link InterestSelectionConfig} so the DB-backed
 *       {@code app_config} values (an admin can change them at runtime) are the single source of truth.
 *       Reuses the same {@link InterestConfigResponse} shape the admin config endpoint returns.</li>
 * </ul>
 *
 * <p>Lives in the {@code api} package so it inherits the package-driven {@code /api/v1} prefix
 * ({@link ApiV1Config}).
 */
@RestController
@RequestMapping("/interests")
public class InterestCatalogueController {

    private final InterestCatalogueRepository catalogue;
    private final InterestSelectionConfig selectionConfig;
    private final UserInterestRepository userInterests;

    public InterestCatalogueController(
            InterestCatalogueRepository catalogue,
            InterestSelectionConfig selectionConfig,
            UserInterestRepository userInterests) {
        this.catalogue = catalogue;
        this.selectionConfig = selectionConfig;
        this.userInterests = userInterests;
    }

    /**
     * The active catalogue for the picker, highlights/popular first then alphabetically — exactly the
     * set the pick-submit path ({@code PATCH /me}) will accept, so a user can never be offered a label
     * the server would then reject.
     *
     * <p>Each row now also carries its real {@code selectionCount} (TM-1094) — how many active users have
     * that interest saved — so the client can order the non-featured tail of each category by actual
     * popularity instead of alphabetically. The counts come from ONE batched
     * {@code COUNT(*) GROUP BY label} ({@link UserInterestRepository#selectionCountsByLabel()}, the same
     * aggregate behind the admin "Selected by" analytics, TM-832) — never an N+1 per interest. It is
     * built into a {@code Map<label, count>} once and joined onto each catalogue row by label; a label no
     * active user has selected is absent from the map and defaults to {@code 0}.
     */
    @GetMapping("/catalogue")
    public List<PublicInterestResponse> catalogue() {
        // ONE grouped scan of user_interest → label → active-user selector count (never per-interest).
        Map<String, Long> countsByLabel = userInterests.selectionCountsByLabel().stream()
                .collect(Collectors.toMap(
                        UserInterestRepository.LabelCount::getLabel,
                        UserInterestRepository.LabelCount::getCount,
                        // A well-formed GROUP BY yields one row per label; keep the larger defensively if
                        // a duplicate key ever slips through so we never throw on the merge.
                        Math::max));
        return catalogue.findByActiveTrueOrderBySortWeightDescLabelAsc().stream()
                .map(c -> PublicInterestResponse.from(c, selectionCountFor(countsByLabel, c.getLabel())))
                .toList();
    }

    /**
     * Look up a label's selection count from the batched map, defaulting a never-selected label to 0 and
     * clamping to {@code int} range (the count is a {@code COUNT(*)} {@code long}; the public field is an
     * {@code int} — real selection counts are far below {@link Integer#MAX_VALUE}, but this stays safe).
     */
    private static int selectionCountFor(Map<String, Long> countsByLabel, String label) {
        long count = countsByLabel.getOrDefault(label, 0L);
        return (int) Math.min(count, Integer.MAX_VALUE);
    }

    /** The interests min/max-selection bounds (DB-backed via {@link InterestSelectionConfig}). */
    @GetMapping("/config")
    public InterestConfigResponse config() {
        return new InterestConfigResponse(selectionConfig.minSelections(), selectionConfig.maxSelections());
    }
}
