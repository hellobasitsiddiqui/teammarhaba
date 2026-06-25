package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.sendgrid.Request;
import com.sendgrid.Response;
import com.teammarhaba.backend.auth.SendGridEmailCodeMailer.SendGridClient;
import java.io.IOException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Unit tests for {@link SendGridEmailCodeMailer} (TM-249) against a <strong>mocked SendGrid
 * client</strong> — no network. They assert the request SendGrid is handed carries the right
 * from-address, the recipient, and a body that contains the code (both plain-text and HTML), and
 * that a non-2xx response or a transport error throws {@link EmailCodeDeliveryException} so the
 * caller surfaces a failed delivery (the {@link EmailCodeMailer} contract).
 */
class SendGridEmailCodeMailerTest {

    private static final String EMAIL = "ada@example.com";
    private static final String CODE = "123456";

    private SendGridClient client;
    private SendGridEmailCodeMailer mailer;

    @BeforeEach
    void setUp() {
        client = mock(SendGridClient.class);
        SendGridProperties props =
                new SendGridProperties("SG.test-key", "no-reply@10xai.co.uk", "TeamMarhaba", "Your sign-in code");
        mailer = new SendGridEmailCodeMailer(client, props);
    }

    @Test
    void sendsMailWithRecipientFromAndCodeInBody() throws IOException {
        when(client.send(any(Request.class))).thenReturn(response(202));

        mailer.sendLoginCode(EMAIL, CODE);

        ArgumentCaptor<Request> captor = ArgumentCaptor.forClass(Request.class);
        verify(client).send(captor.capture());
        Request sent = captor.getValue();

        assertThat(sent.getEndpoint()).isEqualTo("mail/send");
        // The built request body is JSON; assert the recipient, sender, subject and — crucially —
        // the code all made it in, without depending on SendGrid's internal object graph.
        String body = sent.getBody();
        assertThat(body).contains(EMAIL);
        assertThat(body).contains("no-reply@10xai.co.uk");
        assertThat(body).contains("Your sign-in code");
        assertThat(body).contains(CODE);
        // Both a plain-text and an HTML part are present.
        assertThat(body).contains("text/plain");
        assertThat(body).contains("text/html");
    }

    @Test
    void throwsWhenSendGridReturnsNon2xx() throws IOException {
        when(client.send(any(Request.class))).thenReturn(response(401));

        assertThatThrownBy(() -> mailer.sendLoginCode(EMAIL, CODE))
                .isInstanceOf(EmailCodeDeliveryException.class)
                .hasMessageContaining(EMAIL)
                .hasMessageContaining("401")
                // The code must never leak into the failure message.
                .hasMessageNotContaining(CODE);
    }

    @Test
    void throwsWhenTransportFails() throws IOException {
        when(client.send(any(Request.class))).thenThrow(new IOException("connection reset"));

        assertThatThrownBy(() -> mailer.sendLoginCode(EMAIL, CODE))
                .isInstanceOf(EmailCodeDeliveryException.class)
                .hasMessageContaining(EMAIL)
                .hasMessageNotContaining(CODE);
    }

    private static Response response(int statusCode) {
        Response r = new Response();
        r.setStatusCode(statusCode);
        r.setBody("");
        return r;
    }
}
