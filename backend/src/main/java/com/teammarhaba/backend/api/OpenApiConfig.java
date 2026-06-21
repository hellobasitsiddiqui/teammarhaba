package com.teammarhaba.backend.api;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Minimal OpenAPI metadata for the generated spec/UI (TM-76). springdoc discovers the
 * endpoints automatically; this just gives the document a title, version, and description so
 * the spec at {@code /v3/api-docs} and the Swagger UI at {@code /swagger-ui} are properly
 * labelled. The API version tracks the {@code /api/v1} surface (see {@link ApiV1Config}).
 */
@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI teamMarhabaOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("TeamMarhaba Backend API")
                        .version("v1")
                        .description("REST API for the TeamMarhaba backend service."));
    }
}
