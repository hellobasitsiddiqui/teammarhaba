package com.teammarhaba.backend.auth;

import com.sendgrid.Method;
import com.sendgrid.Request;
import com.sendgrid.Response;
import com.sendgrid.SendGrid;
import com.sendgrid.helpers.mail.Mail;
import com.sendgrid.helpers.mail.objects.Content;
import com.sendgrid.helpers.mail.objects.Email;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Real {@link EmailCodeMailer} that delivers the login code through SendGrid (TM-249).
 *
 * <p><strong>Activation.</strong> This bean exists only when {@code app.auth.email-code.sendgrid.api-key}
 * is set (see {@link EmailCodeMailerConfig}); when it is present it <em>wins</em> over the default
 * {@link LoggingEmailCodeMailer} (which is {@code @ConditionalOnMissingBean}). When the key is absent
 * — dev, test, CI, e2e — this bean is simply not created and the logging stub ships, so nothing
 * here reaches the network without a configured key. Under the Firebase Auth emulator the
 * {@code @Primary} recording mailer still wins regardless (it's used by the e2e harness).
 *
 * <p><strong>Secret handling.</strong> The API key is read from {@link SendGridProperties} (sourced
 * from {@code SENDGRID_API_KEY}); it is never logged. The code is a credential — only the recipient
 * address is ever logged, never the code or the message body.
 *
 * <p><strong>Failure posture.</strong> A non-2xx SendGrid response or a transport {@link IOException}
 * throws {@link EmailCodeDeliveryException}, so the caller surfaces a failure rather than telling the
 * user a code was sent that they will never receive (the {@link EmailCodeMailer} contract).
 */
public class SendGridEmailCodeMailer implements EmailCodeMailer {

    private static final Logger log = LoggerFactory.getLogger(SendGridEmailCodeMailer.class);

    private final SendGridClient client;
    private final SendGridProperties props;

    public SendGridEmailCodeMailer(SendGridClient client, SendGridProperties props) {
        this.client = client;
        this.props = props;
    }

    @Override
    public void sendLoginCode(String email, String code) {
        Email from = new Email(props.from(), props.fromName());
        Email to = new Email(email);
        Mail mail = new Mail();
        mail.setFrom(from);
        mail.setSubject(props.subject());
        mail.addContent(new Content("text/plain", plainTextBody(code)));
        mail.addContent(new Content("text/html", htmlBody(code)));
        com.sendgrid.helpers.mail.objects.Personalization personalization =
                new com.sendgrid.helpers.mail.objects.Personalization();
        personalization.addTo(to);
        mail.addPersonalization(personalization);

        Request request = new Request();
        request.setMethod(Method.POST);
        request.setEndpoint("mail/send");
        try {
            request.setBody(mail.build());
            Response response = client.send(request);
            int status = response.getStatusCode();
            if (status < 200 || status >= 300) {
                // Never include the response body — it can echo the request, which contains the code.
                throw new EmailCodeDeliveryException(
                        "SendGrid rejected the login-code email for " + email + " with status " + status);
            }
            log.info("Login code emailed via SendGrid to {} (status {}).", email, status);
        } catch (IOException e) {
            throw new EmailCodeDeliveryException("Failed to send login-code email to " + email + " via SendGrid", e);
        }
    }

    /** Plain-text fallback body. The 6-digit code is the only dynamic content. */
    private static String plainTextBody(String code) {
        return "Your TeamMarhaba sign-in code is: "
                + code
                + "\n\nEnter it to finish signing in. It expires shortly and can be used once."
                + "\n\nIf you didn't request this, you can ignore this email.";
    }

    /** Simple, dependency-free HTML body — no external CSS/images so it renders everywhere. */
    private static String htmlBody(String code) {
        return "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#1a1a1a\">"
                + "<p>Your TeamMarhaba sign-in code is:</p>"
                + "<p style=\"font-size:28px;font-weight:bold;letter-spacing:4px;margin:16px 0\">"
                + code
                + "</p>"
                + "<p>Enter it to finish signing in. It expires shortly and can be used once.</p>"
                + "<p style=\"color:#666;font-size:13px\">If you didn't request this, you can ignore this email.</p>"
                + "</div>";
    }

    /**
     * Thin seam over the SendGrid SDK so the mailer can be unit-tested with a mocked client (the
     * real {@link SendGrid} class makes a live HTTP call and reads the API key at construction).
     */
    public interface SendGridClient {
        Response send(Request request) throws IOException;
    }

    /** Production {@link SendGridClient}: delegates straight to the real SendGrid SDK. */
    public static final class DefaultSendGridClient implements SendGridClient {
        private final SendGrid sendGrid;

        public DefaultSendGridClient(String apiKey) {
            this.sendGrid = new SendGrid(apiKey);
        }

        @Override
        public Response send(Request request) throws IOException {
            return sendGrid.api(request);
        }
    }
}
