package com.teammarhaba.backend.web;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.EmailVerificationService;
import com.teammarhaba.backend.auth.FirebaseAccountStateService;
import com.teammarhaba.backend.common.InvalidListQueryException;
import com.teammarhaba.backend.user.UserAdminService;
import com.teammarhaba.backend.user.UserService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Verifies the global RFC 7807 mappings: validation -> 400, not-found -> 404,
 * conflict -> 409, and an unmapped exception -> a generic 500 that never leaks the
 * underlying message or a stack trace. Security filters are disabled
 * ({@code addFilters = false}) so the test exercises the error model directly, not the
 * default-deny auth chain (TM-79) — these test routes aren't part of the permit-list.
 */
@WebMvcTest
@AutoConfigureMockMvc(addFilters = false)
@Import(GlobalExceptionHandlerTest.TestController.class)
class GlobalExceptionHandlerTest {

    @Autowired
    private MockMvc mockMvc;

    // The web slice loads every @RestController; MeController (TM-112) needs a UserService, an
    // EmailVerificationService (TM-165) and a FirebaseAccountStateService (TM-164), UserAdminController
    // (TM-111) needs a UserAdminService, and AuditController (TM-137) needs an AuditService — none
    // supplied by a @WebMvcTest. These mocks satisfy that wiring; never called, since the tests only
    // hit the local /test routes.
    @MockitoBean
    private UserService userService;

    @MockitoBean
    private EmailVerificationService emailVerificationService;

    @MockitoBean
    private FirebaseAccountStateService accountStateService;

    @MockitoBean
    private UserAdminService userAdminService;

    @MockitoBean
    private AuditService auditService;

    @Test
    void validationErrorReturns400ProblemDetail() throws Exception {
        mockMvc.perform(post("/test/echo")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.errors[0].field").value("name"));
    }

    @Test
    void notFoundReturns404() throws Exception {
        mockMvc.perform(get("/test/missing"))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Resource not found"))
                .andExpect(jsonPath("$.detail").value("widget 42 not found"));
    }

    @Test
    void conflictReturns409() throws Exception {
        mockMvc.perform(get("/test/conflict"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.title").value("Conflict"))
                .andExpect(jsonPath("$.status").value(409));
    }

    @Test
    void invalidListQueryReturns400() throws Exception {
        mockMvc.perform(get("/test/badlist"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Invalid request"))
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.detail").value("Unknown sort property 'ssn'."));
    }

    @Test
    void optimisticLockConflictReturns409() throws Exception {
        mockMvc.perform(get("/test/stale"))
                .andExpect(status().isConflict())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Conflict"))
                .andExpect(jsonPath("$.status").value(409));
    }

    @Test
    void unexpectedReturns500WithoutLeakingDetails() throws Exception {
        mockMvc.perform(get("/test/boom"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.title").value("Internal server error"))
                .andExpect(jsonPath("$.detail").value("An unexpected error occurred."))
                .andExpect(jsonPath("$.trace").doesNotExist());
    }

    @RestController
    @RequestMapping("/test")
    static class TestController {

        record Body(@NotBlank String name) {}

        @PostMapping("/echo")
        void echo(@Valid @RequestBody Body body) {
            // no-op: the @Valid binding is what we exercise
        }

        @GetMapping("/missing")
        void missing() {
            throw new ResourceNotFoundException("widget 42 not found");
        }

        @GetMapping("/conflict")
        void conflict() {
            throw new DataIntegrityViolationException("duplicate key");
        }

        @GetMapping("/stale")
        void stale() {
            throw new ObjectOptimisticLockingFailureException("users", 1L);
        }

        @GetMapping("/badlist")
        void badlist() {
            throw new InvalidListQueryException("Unknown sort property 'ssn'.");
        }

        @GetMapping("/boom")
        void boom() {
            throw new IllegalStateException("secret internal detail");
        }
    }
}
