package com.teammarhaba.backend.api;

import jakarta.validation.constraints.Size;

/**
 * Body for {@code PATCH /api/v1/me} (TM-112). Only the user-editable profile fields — identity
 * ({@code uid}/{@code email}) comes from the verified token and can't be changed here. A
 * {@code null} {@code displayName} leaves it unchanged.
 */
public record UpdateMeRequest(@Size(max = 255) String displayName) {}
