package com.teammarhaba.backend.payments;

/**
 * A verified payment webhook notification (TM-478), reduced to the two facts the checkout flow acts on,
 * so the provider-specific event zoo ({@code ORDER_COMPLETED}, {@code ORDER_AUTHORISED},
 * {@code ORDER_PAYMENT_DECLINED}, …) never leaks past the {@link PaymentProvider} seam.
 *
 * <p>Only produced once the signature has been verified — an unverifiable or malformed payload yields an
 * empty {@code Optional} from {@link PaymentProvider#parseWebhookEvent}, never a {@code PaymentWebhookEvent}.
 *
 * @param providerOrderId the provider's permanent order id the event is about — matched against the local
 *                        {@code Order.provider_order_id} to find the checkout to confirm
 * @param paid            {@code true} when this event means the money has settled and the order should move
 *                        {@code PENDING → CONFIRMED} (Revolut {@code ORDER_COMPLETED}/{@code ORDER_AUTHORISED});
 *                        {@code false} for a decline/cancel/other lifecycle event the confirm path ignores
 */
public record PaymentWebhookEvent(String providerOrderId, boolean paid) {}
