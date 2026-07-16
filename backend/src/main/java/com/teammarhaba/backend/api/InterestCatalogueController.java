package com.teammarhaba.backend.api;

import com.teammarhaba.backend.interests.InterestCatalogueRepository;
import com.teammarhaba.backend.interests.InterestSelectionConfig;
import java.util.List;
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

    public InterestCatalogueController(
            InterestCatalogueRepository catalogue, InterestSelectionConfig selectionConfig) {
        this.catalogue = catalogue;
        this.selectionConfig = selectionConfig;
    }

    /**
     * The active catalogue for the picker, highlights/popular first then alphabetically — exactly the
     * set the pick-submit path ({@code PATCH /me}) will accept, so a user can never be offered a label
     * the server would then reject.
     */
    @GetMapping("/catalogue")
    public List<PublicInterestResponse> catalogue() {
        return catalogue.findByActiveTrueOrderBySortWeightDescLabelAsc().stream()
                .map(PublicInterestResponse::from)
                .toList();
    }

    /** The interests min/max-selection bounds (DB-backed via {@link InterestSelectionConfig}). */
    @GetMapping("/config")
    public InterestConfigResponse config() {
        return new InterestConfigResponse(selectionConfig.minSelections(), selectionConfig.maxSelections());
    }
}
