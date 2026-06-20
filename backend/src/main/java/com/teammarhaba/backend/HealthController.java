package com.teammarhaba.backend;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Minimal liveness endpoint so the CI/CD pipeline has a real, runnable
 * target to build, deploy, and probe. Full Actuator health lands in 1.6.5.
 */
@RestController
public class HealthController {

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }
}
