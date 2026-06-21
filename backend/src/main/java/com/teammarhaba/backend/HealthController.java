package com.teammarhaba.backend;

import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The lightweight, unversioned liveness probe the platform hits: the Cloud Run deploy
 * (TM-60) and load balancers point their probes at {@code /health}, so it stays a tiny,
 * dependency-free 200 that is always public.
 *
 * <p>Full observability now lives in Actuator (TM-74): {@code /actuator/health} (public,
 * with liveness/readiness groups and DB/components detail for authorized callers) plus
 * {@code /actuator/info} and {@code /actuator/metrics} (authenticated). This endpoint is
 * kept deliberately separate — changing the probe path would mean changing the deploy — and
 * simply reports {@code UP}, consistent with Actuator's overall status.
 */
@RestController
public class HealthController {

    @GetMapping(value = "/health", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }
}
