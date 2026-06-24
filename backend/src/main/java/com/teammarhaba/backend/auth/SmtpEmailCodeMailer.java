package com.teammarhaba.backend.auth;

import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.mail.MailException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;

/**
 * Real SMTP-backed {@link EmailCodeMailer} (TM-249): sends the one-time login code to the user's
 * inbox via Spring's {@link JavaMailSender}, configured against Google Workspace SMTP
 * ({@code smtp.gmail.com}, STARTTLS) on the {@code 10xai.co.uk} domain.
 *
 * <p><strong>When it's active.</strong> {@link SmtpEmailCodeMailerConfig} only registers this bean
 * when mail is configured (an explicit {@code app.auth.email-code.smtp.enabled=true} or a
 * {@code spring.mail.host}); otherwise the default {@link LoggingEmailCodeMailer} ships, so dev/e2e
 * keep working with no mail config. When it IS active it wins over the logging default (which backs
 * off via {@code @ConditionalOnMissingBean}). The emulator recorder is {@code @Primary} and unaffected.
 *
 * <p><strong>Fail loud.</strong> The constructor rejects blank credentials: enabling mail but
 * leaving {@code MAIL_USERNAME}/{@code MAIL_PASSWORD} empty fails startup with a clear message rather
 * than silently failing to deliver codes at runtime.
 *
 * <p><strong>Credential hygiene.</strong> The code is treated as a credential — it is placed in the
 * email body only and is <em>never</em> logged. A delivery failure is rethrown so the caller surfaces
 * it (the user never learns a code was issued they can't receive); the recipient address is included
 * in the failure log but the code is not.
 */
public class SmtpEmailCodeMailer implements EmailCodeMailer {

    private static final Logger log = LoggerFactory.getLogger(SmtpEmailCodeMailer.class);

    private final JavaMailSender mailSender;
    private final String from;
    private final String fromName;

    SmtpEmailCodeMailer(
            JavaMailSender mailSender, SmtpEmailCodeProperties props, String username, String password) {
        // Fail loud: mail is enabled but the credentials Spring needs to authenticate to SMTP are
        // missing. Better to refuse to start than to accept logins and silently never deliver codes.
        if (isBlank(username) || isBlank(password)) {
            throw new IllegalStateException(
                    "Email-code SMTP mailer is enabled but mail credentials are blank. "
                            + "Set MAIL_USERNAME and MAIL_PASSWORD (a Google Workspace app password), "
                            + "or disable the SMTP mailer (unset spring.mail.host / "
                            + "app.auth.email-code.smtp.enabled) to fall back to logging.");
        }
        this.mailSender = mailSender;
        this.from = props.from();
        this.fromName = props.fromName();
    }

    @Override
    public void sendLoginCode(String email, String code) {
        try {
            MimeMessage message = mailSender.createMimeMessage();
            MimeMessageHelper helper =
                    new MimeMessageHelper(message, MimeMessageHelper.MULTIPART_MODE_MIXED, StandardCharsets.UTF_8.name());
            helper.setTo(email);
            try {
                helper.setFrom(from, fromName);
            } catch (UnsupportedEncodingException e) {
                // fromName is plain ASCII config; fall back to the bare address rather than fail.
                helper.setFrom(from);
            }
            helper.setSubject("Your TeamMarhaba sign-in code");
            // Plain-text first (fallback), then HTML — order matters for multipart/alternative.
            helper.setText(plainTextBody(code), htmlBody(code));
            mailSender.send(message);
            // The code is a credential and is intentionally omitted from this log line.
            log.info("Login code emailed to {}.", email);
        } catch (MessagingException | MailException e) {
            // Surface the failure to the caller (EmailCodeService) so the user is told delivery
            // failed, rather than being handed a code they can never receive. No code in the log.
            log.warn("Failed to email login code to {}.", email, e);
            throw new EmailCodeDeliveryException("Failed to send the login code email.", e);
        }
    }

    private static String plainTextBody(String code) {
        return "Your TeamMarhaba sign-in code is:\n\n"
                + "    " + code + "\n\n"
                + "Enter it to finish signing in. It expires shortly and can only be used once.\n\n"
                + "If you didn't request this, you can safely ignore this email.\n\n"
                // Attribution byline (TM-254): subtle one-line credit in the email footer.
                + "—\nA product of 10xAI · https://10xai.co.uk\n";
    }

    private static String htmlBody(String code) {
        return "<!DOCTYPE html><html><body style=\"font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;\">"
                + "<p>Your TeamMarhaba sign-in code is:</p>"
                + "<p style=\"font-size:28px;font-weight:bold;letter-spacing:4px;margin:16px 0;\">"
                + escape(code)
                + "</p>"
                + "<p>Enter it to finish signing in. It expires shortly and can only be used once.</p>"
                + "<p style=\"color:#666;font-size:13px;\">If you didn't request this, "
                + "you can safely ignore this email.</p>"
                // Attribution byline (TM-254): subtle one-line credit in the email footer.
                + "<p style=\"color:#999;font-size:12px;margin-top:24px;\">A product of "
                + "<a href=\"https://10xai.co.uk\" style=\"color:#999;\">10xAI</a></p>"
                + "</body></html>";
    }

    /** Minimal HTML escaping for the code (digits today, but defensive if the format ever widens). */
    private static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
