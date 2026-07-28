package com.teammarhaba.backend.api;

import com.teammarhaba.backend.city.CityCatalogueRepository;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public (any signed-in user) READ endpoint for the city picker under {@code /api/v1/cities}
 * (TM-1089). Backs the onboarding/profile city picker: a user needs to see the active city catalogue,
 * but the whole {@link CityAdminController} is {@code ADMIN}-gated. This controller closes that gap
 * with a lean read-only surface, mirroring {@link InterestCatalogueController}.
 *
 * <p><b>Authorization:</b> there is deliberately NO {@code @PreAuthorize} here — the endpoint inherits
 * the default-authenticated security chain ({@code SecurityConfig}: everything under {@code /api/v1}
 * that is not permit-listed requires a verified Firebase token). So ANY signed-in user gets a
 * {@code 200}; an anonymous caller gets a uniform {@code 401}.
 *
 * <ul>
 *   <li>{@code GET /cities/catalogue} — the CURRENTLY OFFERED cities (active + not tombstoned), ordered
 *       by weight (higher first) then alphabetically. Returns the lean {@link PublicCityResponse}
 *       (name/country/icon/geo) — the admin/internal fields and the big empty-state image path are
 *       intentionally not leaked. No paging: the catalogue is small.</li>
 * </ul>
 *
 * <p>Lives in the {@code api} package so it inherits the package-driven {@code /api/v1} prefix
 * ({@link ApiV1Config}).
 */
@RestController
@RequestMapping("/cities")
public class CityCatalogueController {

    private final CityCatalogueRepository catalogue;

    public CityCatalogueController(CityCatalogueRepository catalogue) {
        this.catalogue = catalogue;
    }

    /**
     * The active catalogue for the picker, weight-first then alphabetically — exactly the set the
     * profile city validation will accept, so a user can never be offered a city the server would reject.
     */
    @GetMapping("/catalogue")
    public List<PublicCityResponse> catalogue() {
        return catalogue.findByActiveTrueOrderBySortWeightDescNameAsc().stream()
                .map(PublicCityResponse::from)
                .toList();
    }
}
